#!/usr/bin/env node
/**
 * MCP Server for Actual Budget
 *
 * This server exposes your Actual Budget data to LLMs through the Model Context Protocol,
 * allowing for natural language interaction with your financial data.
 *
 * Features:
 * - List and view accounts
 * - View transactions with filtering
 * - Generate financial statistics and analysis
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { isValidBearerToken } from './utils/bearer-auth.js';
import { initActualApi, shutdownActualApi } from './actual-api.js';
import { fetchAllAccounts } from './core/data/fetch-accounts.js';
import { createServer } from './server.js';
import { createStatelessMcpHandler } from './http/stateless-mcp-handler.js';

// Reason: dotenv@17 (dotenvx) prints to stdout by default, which breaks MCP stdio JSON parsing
dotenv.config({ path: '.env', quiet: true } as Parameters<typeof dotenv.config>[0]);

// Argument parsing
const {
  values: {
    sse: useSse,
    'enable-write': enableWrite,
    'enable-bearer': enableBearer,
    port,
    'test-resources': testResources,
    'test-custom': testCustom,
  },
} = parseArgs({
  options: {
    sse: { type: 'boolean', default: false },
    'enable-write': { type: 'boolean', default: false },
    'enable-bearer': { type: 'boolean', default: false },
    port: { type: 'string' },
    'test-resources': { type: 'boolean', default: false },
    'test-custom': { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const resolvedPort = parseInt(port ?? process.env.PORT ?? '3000', 10);

// Bearer authentication middleware
const bearerAuth = (req: Request, res: Response, next: NextFunction): void => {
  if (!enableBearer) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({
      error: 'Authorization header required',
    });
    return;
  }

  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: "Authorization header must start with 'Bearer '",
    });
    return;
  }

  const token = authHeader.substring(7); // Remove "Bearer " prefix
  const expectedToken = process.env.BEARER_TOKEN;

  if (!expectedToken) {
    console.error('BEARER_TOKEN environment variable not set');
    res.status(500).json({
      error: 'Server configuration error',
    });
    return;
  }

  if (!isValidBearerToken(token, expectedToken)) {
    res.status(401).json({
      error: 'Invalid bearer token',
    });
    return;
  }

  next();
};

/**
 * Safely stringify values for logging without throwing on circular structures.
 */
const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
};

const toErrorMessage = (value: unknown): string =>
  value instanceof Error ? `${value.name}: ${value.message}` : safeStringify(value);

// ----------------------------
// SERVER STARTUP
// ----------------------------

// Start the server
async function main(): Promise<void> {
  // If testing resources, verify connectivity and list accounts, then exit
  if (testResources) {
    console.log('Testing resources...');
    try {
      await initActualApi();
      const accounts = await fetchAllAccounts();
      console.log(`Found ${accounts.length} account(s).`);
      accounts.forEach((account) => console.log(`- ${account.id}: ${account.name}`));
      console.log('Resource test passed.');
      await shutdownActualApi();
      process.exit(0);
    } catch (error) {
      console.error('Resource test failed:', error);
      process.exit(1);
    }
  }

  if (testCustom) {
    console.log('Initializing custom test...');
    try {
      await initActualApi();

      // Custom test here

      // ----------------

      console.log('Custom test passed.');
      await shutdownActualApi();
      process.exit(0);
    } catch (error) {
      console.error('Custom test failed:', error);
    }
  }

  // Validate environment variables
  if (!process.env.ACTUAL_DATA_DIR && !process.env.ACTUAL_SERVER_URL) {
    console.error('Warning: Neither ACTUAL_DATA_DIR nor ACTUAL_SERVER_URL is set.');
  }

  if (process.env.ACTUAL_SERVER_URL && !process.env.ACTUAL_PASSWORD) {
    console.error('Warning: ACTUAL_SERVER_URL is set but ACTUAL_PASSWORD is not.');
    console.error('If your server requires authentication, initialization will fail.');
  }

  if (useSse) {
    const app = express();
    app.use(express.json());

    app.get('/healthz', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    if (enableBearer) {
      process.stderr.write('Bearer authentication enabled for SSE endpoints\n');
    } else {
      process.stderr.write('Bearer authentication disabled - endpoints are public\n');
    }

    // Legacy SSE remains connection-oriented; Streamable HTTP is stateless.
    const legacySseConnections = new Map<string, { server: Server; transport: SSEServerTransport }>();

    app.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/sse'], (_req, res) => {
      res.status(404).json({ error: 'OAuth metadata not configured for this server' });
    });
    app.get(['/sse/.well-known/oauth-authorization-server'], (_req, res) => {
      res.status(404).json({ error: 'OAuth metadata not configured for this server' });
    });

    const handleLegacySse = (_req: Request, res: Response): void => {
      const connectionId = randomUUID();
      const connServer = createServer({ enableWrite: !!enableWrite });
      const sseTransport = new SSEServerTransport(`/messages?connectionId=${connectionId}`, res);
      legacySseConnections.set(connectionId, { server: connServer, transport: sseTransport });

      connServer.connect(sseTransport).then(() => {
        process.stderr.write(`Legacy SSE connection established (connectionId ${connectionId})\n`);
      });

      res.on('close', () => {
        legacySseConnections.delete(connectionId);
        connServer.close();
      });
    };

    app.get('/sse', bearerAuth, handleLegacySse);

    const streamablePaths = ['/', '/mcp'];
    app.post(streamablePaths, bearerAuth, createStatelessMcpHandler({ enableWrite: !!enableWrite }));
    app.get(streamablePaths, bearerAuth, (_req, res) => {
      res.status(405).set('Allow', 'POST').json({ error: 'Use POST for stateless Streamable HTTP requests' });
    });
    app.delete(streamablePaths, bearerAuth, (_req, res) => {
      res.status(405).set('Allow', 'POST').json({ error: 'Stateless Streamable HTTP has no session to delete' });
    });

    app.post('/messages', bearerAuth, async (req: Request, res: Response) => {
      const connectionId = req.query.connectionId as string | undefined;
      const conn = connectionId ? legacySseConnections.get(connectionId) : undefined;
      if (conn) {
        await conn.transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).json({ error: 'Invalid or missing connectionId' });
      }
    });

    app.listen(resolvedPort, (error) => {
      if (error) {
        process.stderr.write(`Error: ${toErrorMessage(error)}\n`);
      } else {
        process.stderr.write(`Actual Budget MCP Server (HTTP) listening on port ${resolvedPort}\n`);
      }
    });
    // SIGINT handler: close all active connections
    process.on('SIGINT', () => {
      process.stderr.write('SIGINT received, shutting down server\n');
      for (const [, conn] of legacySseConnections) {
        conn.server.close();
      }
      process.exit(0);
    });
  } else {
    const server = createServer({ enableWrite: !!enableWrite });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Actual Budget MCP Server (stdio) started');

    process.on('SIGINT', () => {
      console.error('SIGINT received, shutting down server');
      server.close();
      process.exit(0);
    });
  }
}

// Reason: async side effects inside @actual-app/api can otherwise terminate the
// process and leave HTTP clients connected to a server that never responds.
process.on('unhandledRejection', (reason) => {
  console.error(`Unhandled rejection: ${toErrorMessage(reason)}`);
});
process.on('uncaughtException', (error) => {
  console.error(`Uncaught exception: ${toErrorMessage(error)}`);
});

main().catch((error: unknown) => {
  console.error(`Server error: ${toErrorMessage(error)}`);
  process.exit(1);
});
