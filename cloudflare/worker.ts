import { Container, getContainer } from '@cloudflare/containers';
import { isValidBearerToken } from '../src/utils/bearer-auth.js';

const CONTAINER_ID = 'actual-mcp-singleton';
const MCP_PATH = '/mcp';

export class ActualMcpContainer extends Container {
  defaultPort = 3000;
  requiredPorts = [3000];
  sleepAfter = '10m';
  enableInternet = true;
}

export interface ContainerStartOptions {
  ports: number[];
  startOptions: {
    enableInternet: boolean;
    entrypoint: string[];
    envVars: Record<string, string>;
  };
  cancellationOptions: {
    instanceGetTimeoutMS: number;
    portReadyTimeoutMS: number;
  };
}

export interface ActualContainerStub {
  fetch(request: Request): Promise<Response>;
  startAndWaitForPorts(options: ContainerStartOptions): Promise<void>;
}

export type ActualContainerResolver = (binding: Env['ACTUAL_MCP_CONTAINER'], name: string) => ActualContainerStub;

function json(data: unknown, status: number): Response {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function isAuthorized(request: Request, expectedToken: string): boolean {
  const authorization = request.headers.get('Authorization');
  const match = authorization ? /^Bearer[ \t]+([^ \t]+)$/i.exec(authorization) : null;
  return !!match && isValidBearerToken(match[1], expectedToken);
}

function containerEnvironment(env: Env): Record<string, string> {
  return {
    ACTUAL_BUDGET_SYNC_ID: env.ACTUAL_BUDGET_SYNC_ID,
    ACTUAL_DATA_DIR: '/tmp/actual-data',
    ACTUAL_PASSWORD: env.ACTUAL_PASSWORD,
    ACTUAL_SERVER_URL: env.ACTUAL_SERVER_URL,
    ACTUAL_SYNC_TTL_MS: env.ACTUAL_SYNC_TTL_MS,
    BEARER_TOKEN: env.BEARER_TOKEN,
    NODE_ENV: 'production',
    PORT: '3000',
    ...(env.ACTUAL_BUDGET_ENCRYPTION_PASSWORD
      ? { ACTUAL_BUDGET_ENCRYPTION_PASSWORD: env.ACTUAL_BUDGET_ENCRYPTION_PASSWORD }
      : {}),
  };
}

export async function handleWorkerRequest(
  request: Request,
  env: Env,
  resolveContainer: ActualContainerResolver
): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  if (pathname === '/healthz') {
    return json({ ok: true, container: 'on-demand' }, 200);
  }

  if (pathname !== MCP_PATH) return json({ error: 'Not found' }, 404);
  if (!env.BEARER_TOKEN) return json({ error: 'Server authentication is not configured' }, 503);

  if (!isAuthorized(request, env.BEARER_TOKEN)) {
    return Response.json(
      { error: 'Unauthorized' },
      {
        status: 401,
        headers: {
          'Cache-Control': 'no-store',
          'WWW-Authenticate': 'Bearer realm="actual-mcp"',
        },
      }
    );
  }

  const container = resolveContainer(env.ACTUAL_MCP_CONTAINER, CONTAINER_ID);

  try {
    await container.startAndWaitForPorts({
      ports: [3000],
      startOptions: {
        enableInternet: true,
        entrypoint: ['node', 'build/index.js', '--sse', '--enable-write', '--enable-bearer'],
        envVars: containerEnvironment(env),
      },
      cancellationOptions: {
        instanceGetTimeoutMS: 15_000,
        portReadyTimeoutMS: 60_000,
      },
    });
    return await container.fetch(request);
  } catch (error) {
    console.error('Actual MCP container request failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return json({ error: 'Actual MCP container is unavailable' }, 503);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleWorkerRequest(request, env, (binding, name) => getContainer(binding, name));
  },
} satisfies ExportedHandler<Env>;
