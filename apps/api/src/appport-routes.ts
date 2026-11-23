/**
 * Fastify adapter for the AppPort HTTP binding and the MCP Streamable HTTP handler.
 *
 * This file contains no business logic: each request is handed to the same WHATWG handlers the
 * AppPort packages produce, which dispatch through `AppPortApplication.handleRequest`.
 */
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppPortRuntime } from '@mi/capabilities';

/** Paths served by the AppPort HTTP binding (`@appport/server`). */
export const APPPORT_PATHS = [
  '/.well-known/appport',
  '/appport',
  '/appport/manifest',
  '/appport/public',
  '/appport/events',
] as const;

export const MCP_PATH = '/mcp';

const OMIT_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
]);

function toWebRequest(req: FastifyRequest): Request {
  const host = req.headers.host ?? 'localhost';
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto =
    (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0] ?? 'http';
  const url = new URL(req.url, `${proto}://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }

  const body =
    req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : typeof req.body === 'string'
        ? req.body
        : req.body === undefined || req.body === null
          ? undefined
          : JSON.stringify(req.body);

  return new Request(url, {
    method: req.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}

async function sendWebResponse(reply: FastifyReply, response: Response): Promise<void> {
  reply.code(response.status);
  response.headers.forEach((value, key) => {
    if (OMIT_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    reply.header(key, value);
  });

  if (!response.body) {
    reply.send();
    return;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/x-ndjson') || contentType.includes('text/event-stream')) {
    reply.send(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]));
    return;
  }

  reply.send(Buffer.from(await response.arrayBuffer()));
}

function delegate(handler: (request: Request) => Promise<Response>) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const response = await handler(toWebRequest(req));
    await sendWebResponse(reply, response);
  };
}

export function registerAppPortRoutes(app: FastifyInstance, runtime: AppPortRuntime): void {
  const appPort = delegate(runtime.httpHandler);
  for (const path of APPPORT_PATHS) app.all(path, appPort);

  // MCP is a projection of the same application; it never bypasses AppPort authorization.
  app.all(MCP_PATH, delegate(runtime.mcpHandler));
}
