import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Request, Response } from 'express';
import { createServer } from '../server.js';

interface StatelessMcpHandlerOptions {
  enableWrite: boolean;
  serverFactory?: typeof createServer;
  transportFactory?: () => StreamableHTTPServerTransport;
}

function toErrorMessage(value: unknown): string {
  return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
}

/**
 * Creates a per-request Streamable HTTP handler without MCP sessions.
 *
 * Stateless mode avoids session affinity requirements in gateways that do not
 * preserve `Mcp-Session-Id` between initialization and later tool requests.
 *
 * @param options - Handler configuration and optional test factories
 * @returns An Express handler for Streamable HTTP POST requests
 */
export function createStatelessMcpHandler(options: StatelessMcpHandlerOptions) {
  const serverFactory = options.serverFactory ?? createServer;
  const transportFactory =
    options.transportFactory ??
    (() =>
      new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      }));

  return async (req: Request, res: Response): Promise<void> => {
    const requestServer: Server = serverFactory({ enableWrite: options.enableWrite });
    const transport = transportFactory();
    let closePromise: Promise<void> | undefined;

    const closeTransport = (): Promise<void> => {
      closePromise ??= transport.close();
      return closePromise;
    };

    res.once('close', () => {
      void closeTransport();
    });

    try {
      await requestServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      process.stderr.write(`Streamable HTTP handler error for ${req.method} ${req.path}: ${toErrorMessage(error)}\n`);

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    } finally {
      await closeTransport().catch((error: unknown) => {
        process.stderr.write(`Failed to close Streamable HTTP transport: ${toErrorMessage(error)}\n`);
      });
    }
  };
}
