import Fastify from 'fastify';
import cors from '@fastify/cors';
import { pathToFileURL } from 'node:url';
import { CodexRunner } from './providers/codex-runner.js';
import { AgyRunner } from './providers/agy-runner.js';
import { registerRoutes, type RouteOptions } from './routes.js';
import { errorBody } from './types.js';

export async function buildServer(options: Partial<RouteOptions> & { logger?: boolean } = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 4 * 1024 * 1024,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  // '*' permits app://obsidian.md as well as browser/desktop clients without cookies.
  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    // Reflect requested headers, including OpenAI SDK x-stainless-* metadata.
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    reply.code(status).send(errorBody(error instanceof Error ? error : new Error('Request failed.'), status < 500 ? 'invalid_request_error' : 'server_error'));
  });
  registerRoutes(app, {
    providers: options.providers ?? { codex: new CodexRunner(), agy: new AgyRunner() },
    modelIds: options.modelIds ?? (process.env.PROXY_MODELS ?? '').split(',').map(id => id.trim()).filter(Boolean),
    timeoutMs: options.timeoutMs ?? positiveInteger(process.env.CLI_TIMEOUT_MS, 120_000, 'CLI_TIMEOUT_MS'),
  });
  return app;
}

function positiveInteger(input: string | undefined, fallback: number, name: string): number {
  const value = input === undefined ? fallback : Number(input);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

async function main() {
  const app = await buildServer();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await app.close(); }
    catch (error) { app.log.error(error); process.exitCode = 1; }
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  try {
    const port = positiveInteger(process.env.PORT, 3000, 'PORT');
    if (port > 65535) throw new Error('PORT must be at most 65535.');
    await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
  } catch (error) {
    app.log.error(error);
    await shutdown();
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
