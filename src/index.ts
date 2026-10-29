import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';
import { pathToFileURL } from 'node:url';
import { CodexRunner } from './providers/codex-runner.js';
import { AgyRunner } from './providers/agy-runner.js';
import { registerRoutes, type RouteOptions } from './routes.js';
import { errorBody } from './types.js';
import { loadServerEnv, readConfig, authenticate, positiveInteger, type Config } from './config.js';

export async function buildServer(options: Partial<RouteOptions> & { logger?: boolean; config?: Config } = {}) {
  const config = options.config ?? readConfig();
  const app = Fastify({
    logger: options.logger === false ? false : { redact: ['req.headers.authorization', 'req.headers.cookie'], level: 'info' },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 4 * 1024 * 1024,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  // Desktop clients without Origin still authenticate; browser origins are explicit.
  await app.register(cors, {
    origin: config.origins,
    methods: ['GET', 'POST', 'OPTIONS'],
    // Reflect requested headers, including OpenAI SDK x-stainless-* metadata.
  });
  const rate = new Map<string, { start: number; count: number }>();
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS' || request.url === '/health') return;
    const auth = authenticate(config, request.headers.authorization ?? '');
    const now = Date.now();
    const bucket = rate.get(auth.identity);
    if (!bucket || now - bucket.start > 60_000) rate.set(auth.identity, { start: now, count: 1 });
    else if (++bucket.count > config.maxRequestsPerMinute) return reply.code(429).send(errorBody(new Error('Request rate exceeded.'), 'rate_limit'));
  });
  app.setErrorHandler((error, request, reply) => {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && !error.code.startsWith('FST_') ? error.code : status < 500 ? 'invalid_request_error' : 'server_error';
    request.log.warn({ requestId: request.id, errorCode: code, statusCode: status, outcome: 'rejected' }, 'Request rejected');
    reply.code(status).send(errorBody(error instanceof Error ? error : new Error('Request failed.'), code));
  });
  registerRoutes(app, {
    config,
    providers: options.providers ?? { codex: new CodexRunner(), agy: new AgyRunner() },
    modelIds: options.modelIds ?? (process.env.PROXY_MODELS ?? '').split(',').map(id => id.trim()).filter(Boolean),
    timeoutMs: options.timeoutMs ?? positiveInteger(process.env.CLI_TIMEOUT_MS, 120_000, 'CLI_TIMEOUT_MS'),
    approvalTimeoutMs: options.approvalTimeoutMs ?? config.approvalTimeoutMs,
    ...(options.modelCacheTtlMs === undefined ? {} : { modelCacheTtlMs: options.modelCacheTtlMs }),
  });
  return app;
}

async function main() {
  loadServerEnv();
  const config = readConfig();
  const app = await buildServer({ config });
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
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error(error);
    await shutdown();
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Server startup failed: ${error instanceof Error ? error.message : 'Invalid configuration.'}`); process.exitCode = 1; });
}
