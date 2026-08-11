import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/containers', () => ({
  Container: class {},
  getContainer: vi.fn(),
}));

import type { ActualContainerResolver, ActualContainerStub } from './worker.js';
import { handleWorkerRequest } from './worker.js';

const token = 'correct-horse-battery-staple';

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    ACTUAL_BUDGET_SYNC_ID: 'budget-id',
    ACTUAL_MCP_CONTAINER: {} as Env['ACTUAL_MCP_CONTAINER'],
    ACTUAL_PASSWORD: 'actual-password',
    ACTUAL_SERVER_URL: 'https://actual.example',
    ACTUAL_SYNC_TTL_MS: '60000',
    BEARER_TOKEN: token,
    ...overrides,
  };
}

function createContainer(): ActualContainerStub {
  return {
    fetch: vi.fn(async () => Response.json({ proxied: true })),
    startAndWaitForPorts: vi.fn(async () => undefined),
  };
}

describe('handleWorkerRequest', () => {
  let container: ActualContainerStub;
  let resolveContainer: ActualContainerResolver;

  beforeEach(() => {
    container = createContainer();
    resolveContainer = vi.fn(() => container);
  });

  it('starts the authenticated container and forwards MCP requests', async () => {
    const request = new Request('https://actual.example/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    const response = await handleWorkerRequest(request, createEnv(), resolveContainer);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ proxied: true });
    expect(resolveContainer).toHaveBeenCalledOnce();
    expect(container.startAndWaitForPorts).toHaveBeenCalledWith(
      expect.objectContaining({
        ports: [3000],
        startOptions: expect.objectContaining({
          entrypoint: ['node', 'build/index.js', '--sse', '--enable-write', '--enable-bearer'],
          envVars: expect.objectContaining({ BEARER_TOKEN: token, PORT: '3000' }),
        }),
      })
    );
    expect(container.fetch).toHaveBeenCalledWith(request);
  });

  it('rejects anonymous MCP requests before starting a container', async () => {
    const response = await handleWorkerRequest(
      new Request('https://actual.example/mcp', { method: 'POST' }),
      createEnv(),
      resolveContainer
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="actual-mcp"');
    expect(resolveContainer).not.toHaveBeenCalled();
  });

  it('returns 404 for paths outside the MCP and health endpoints', async () => {
    const response = await handleWorkerRequest(
      new Request('https://actual.example/private'),
      createEnv(),
      resolveContainer
    );

    expect(response.status).toBe(404);
    expect(resolveContainer).not.toHaveBeenCalled();
  });

  it('returns 503 without leaking details when container startup fails', async () => {
    vi.mocked(container.startAndWaitForPorts).mockRejectedValueOnce(new Error('internal detail'));
    const response = await handleWorkerRequest(
      new Request('https://actual.example/mcp', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }),
      createEnv(),
      resolveContainer
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Actual MCP container is unavailable' });
  });
});
