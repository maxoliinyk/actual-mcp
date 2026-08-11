import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Request, Response } from 'express';
import { Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createStatelessMcpHandler } from './stateless-mcp-handler.js';

const requestHeaders = {
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
};

async function startTestServer(): Promise<{ server: HttpServer; url: string }> {
  const app = express();
  app.use(express.json());
  app.post('/mcp', createStatelessMcpHandler({ enableWrite: false }));

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}/mcp` });
    });
    server.once('error', reject);
  });
}

async function stopTestServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function post(url: string, body: object): Promise<globalThis.Response> {
  return fetch(url, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

function responseDouble(): Response {
  const response = {
    headersSent: false,
    once: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return response as unknown as Response;
}

describe('createStatelessMcpHandler', () => {
  it('accepts a headerless follow-up request after initialization', async () => {
    const { server, url } = await startTestServer();

    try {
      const initialize = await post(url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'stateless-handler-test', version: '1.0.0' },
        },
      });
      const tools = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const toolsBody = (await tools.json()) as { result?: { tools?: unknown[] } };

      expect(initialize.status).toBe(200);
      expect(initialize.headers.get('mcp-session-id')).toBeNull();
      expect(tools.status).toBe(200);
      expect(toolsBody.result?.tools?.length).toBeGreaterThan(0);
    } finally {
      await stopTestServer(server);
    }
  });

  it('isolates concurrent headerless requests', async () => {
    const { server, url } = await startTestServer();

    try {
      const responses = await Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          post(url, { jsonrpc: '2.0', id: index + 1, method: 'tools/list', params: {} })
        )
      );

      expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects an empty protocol request', async () => {
    const { server, url } = await startTestServer();

    try {
      const response = await post(url, {});

      expect(response.status).toBe(400);
    } finally {
      await stopTestServer(server);
    }
  });

  it('returns a protocol-safe 500 response when setup fails', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const handler = createStatelessMcpHandler({
      enableWrite: false,
      serverFactory: (() => ({ connect: vi.fn().mockRejectedValue(new Error('connect failed')) })) as never,
      transportFactory: () =>
        ({ close: vi.fn().mockResolvedValue(undefined) }) as unknown as StreamableHTTPServerTransport,
    });
    const response = responseDouble();

    try {
      await handler({ method: 'POST', path: '/mcp', body: {} } as Request, response);
    } finally {
      stderr.mockRestore();
    }

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ jsonrpc: '2.0', error: expect.objectContaining({ code: -32603 }) })
    );
  });
});
