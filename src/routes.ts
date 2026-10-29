import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { CliRunner } from './providers/base.js';
import { ProxyError, errorBody, type ChatCompletionChunk, type ChatCompletionRequest, type Model } from './types.js';
import { ModelCatalog } from './models.js';
import { SessionManager, type AgentSession } from './sessions.js';
import type { ToolCall } from './types.js';
import { authenticate, executionContext, type Config } from './config.js';
import { canonicalModel } from './models.js';

export interface RouteOptions {
  config: Config;
  providers: Record<'codex' | 'agy', CliRunner>;
  modelIds?: string[];
  timeoutMs?: number;
  approvalTimeoutMs?: number;
  modelCacheTtlMs?: number;
}

const bodySchema = {
  type: 'object', required: ['model', 'messages'], additionalProperties: true,
  properties: {
    model: { type: 'string', pattern: '^(codex|agy)/[^\\s]+$', maxLength: 200 },
    messages: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', required: ['role'], additionalProperties: true,
        allOf: [
          { if: { properties: { role: { enum: ['system', 'developer', 'user', 'tool'] } } }, then: { required: ['content'], properties: { content: { not: { type: 'null' } } } } },
          { if: { properties: { role: { const: 'tool' } } }, then: { required: ['tool_call_id'] } },
          { if: { properties: { role: { const: 'assistant' } } }, then: { anyOf: [{ required: ['content'] }, { required: ['tool_calls'] }] } },
        ],
        properties: {
          role: { type: 'string', enum: ['system', 'developer', 'user', 'assistant', 'tool'] },
          content: { anyOf: [
            { type: 'string' },
            { type: 'null' },
            { type: 'array', items: {
              type: 'object', required: ['type', 'text'], additionalProperties: false,
              properties: { type: { const: 'text' }, text: { type: 'string' } },
            } },
          ] },
          tool_call_id: { type: 'string' },
          tool_calls: { type: 'array', items: {
            type: 'object', required: ['id', 'type', 'function'], properties: {
              id: { type: 'string' }, type: { const: 'function' }, function: {
                type: 'object', required: ['name', 'arguments'], properties: { name: { type: 'string' }, arguments: { type: 'string' } },
              },
            },
          } },
        },
      },
    },
    stream: { type: 'boolean' },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    stream_options: { type: 'object', properties: { include_usage: { type: 'boolean' } } },
    tools: { type: 'array', maxItems: 128, items: {
      type: 'object', required: ['type', 'function'], properties: {
        type: { const: 'function' }, function: {
          type: 'object', required: ['name'], properties: {
            name: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$' },
            description: { type: 'string' }, parameters: { type: 'object' },
          },
        },
      },
    } },
    user: { type: 'string' }, conversation_id: { type: 'string' },
    n: { type: 'integer', const: 1 },
  },
} as const;

async function write(response: ServerResponse, data: string): Promise<void> {
  if (response.destroyed) throw new ProxyError('Client disconnected.', 499, 'client_disconnected');
  // Await the callback to apply backpressure to the CLI stdout iterator.
  await new Promise<void>((resolve, reject) => {
    response.write(data, error => error ? reject(error) : resolve());
  });
}

export function registerRoutes(app: FastifyInstance, options: RouteOptions): void {
  const active = new Set<AbortController>();
  const sessions = new SessionManager(options.timeoutMs, options.approvalTimeoutMs, options.config.maxSessions);
  const catalog = new ModelCatalog(options.providers.agy, options.modelIds, options.modelCacheTtlMs);
  app.addHook('preClose', async () => {
    for (const controller of active) controller.abort(new ProxyError('Server is shutting down.', 503, 'server_shutdown'));
    catalog.close();
    await sessions.close();
  });
  const created = Math.floor(Date.now() / 1000);
  app.get('/health', async () => ({ status: 'ok', active_requests: active.size, active_sessions: sessions.size }));
  app.get('/v1/capabilities', async request => ({
    authentication: 'required', configured_workspaces: authenticate(options.config, request.headers.authorization ?? '').client.workspaces,
    providers: { codex: { transport: 'app-server', client_tools: true, model_fallback: false, session_mode: 'ephemeral', authentication_verified: false },
      agy: { transport: 'stream-json', client_tools: false, isolated_hook_injection: false, authentication_verified: false } },
    profiles: Object.fromEntries(Object.entries(options.config.profiles).filter(([id]) => authenticate(options.config, request.headers.authorization ?? '').client.profiles.includes(id)).map(([id, p]) => [id, { provider: p.provider, policy: p.policy, tools: p.tools, models: p.models }])),
  }));
  if (options.config.diagnostics) app.get('/v1/diagnostics', async () => ({
    // --help is a bounded availability probe; it does not validate credentials or models.
    providers: Object.fromEntries(await Promise.all(Object.entries(options.providers).map(async ([id, runner]) => [id, { ...(await runner.diagnose?.() ?? { available: null }), authentication_verified: false }]))),
  }));
  app.get('/v1/models', async () => {
    const models: Model[] = (await catalog.list()).map(id => ({ id, object: 'model', created, owned_by: id.split('/')[0]! }));
    return { object: 'list', data: models };
  });

  app.post<{ Body: ChatCompletionRequest }>('/v1/chat/completions', { schema: { body: bodySchema } }, async (request, reply) => {
    const body = request.body;
    const auth = authenticate(options.config, request.headers.authorization ?? '');
    const header = (name: string, fallback: string) => {
      const value = request.headers[name];
      if (value !== undefined && typeof value !== 'string') throw new ProxyError('Invalid proxy selection header.', 400, 'invalid_request_error');
      return value ?? fallback;
    };
    const context = executionContext(options.config, auth, header('x-proxy-workspace', options.config.defaultWorkspace), header('x-proxy-profile', body.model.split('/')[0]!), canonicalModel(body.model));
    if (body.tools?.length && (context.profile.tools === 'none' || context.profile.provider === 'agy')) throw new ProxyError('This profile/provider cannot bridge client tools. Use Codex dynamic tools.', 400, 'tool_not_supported');
    if (new Set(body.tools?.map(t => t.function.name)).size !== (body.tools?.length ?? 0)) throw new ProxyError('Tool names must be unique.', 400, 'invalid_request_error');
    const slash = body.model.indexOf('/');
    const provider = options.providers[body.model.slice(0, slash) as 'codex' | 'agy'];
    const controller = new AbortController();
    let session: AgentSession | undefined;
    const started = Date.now();
    let outcome = 'completed';
    let errorCode: string | undefined;
    controller.signal.addEventListener('abort', () => session?.cancel(controller.signal.reason as Error), { once: true });
    active.add(controller);
    const disconnect = () => controller.abort(new ProxyError('Client disconnected.', 499, 'client_disconnected'));
    // IncomingMessage close also fires for a normally consumed request body in modern Node.
    const requestClose = () => { if (request.raw.aborted || !request.raw.complete) disconnect(); };
    const responseClose = () => { if (!reply.raw.writableFinished) disconnect(); };
    request.raw.on('aborted', disconnect);
    request.raw.on('close', requestClose);
    reply.raw.on('close', responseClose);
    if (request.raw.aborted || reply.raw.destroyed) disconnect();
    let heartbeat: NodeJS.Timeout | undefined;
    const meta = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: body.model };
    const chunk = (delta: ChatCompletionChunk['choices'][number]['delta'], finish: 'stop' | 'tool_calls' | null = null): ChatCompletionChunk => ({
      ...meta, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const send = (data: unknown) => write(reply.raw, `data: ${JSON.stringify(data)}\n\n`);
    try {
      controller.signal.throwIfAborted();
      session = sessions.acquire(body, provider, auth.identity, context);
      if (body.stream) {
        reply.hijack();
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) reply.raw.setHeader(name, value);
        }
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        await send(chunk({ role: 'assistant' }));
        heartbeat = setInterval(() => {
          if (!reply.raw.destroyed && !reply.raw.writableNeedDrain) reply.raw.write(': keep-alive\n\n');
        }, 15_000);
        heartbeat.unref();
      }
      let content = '';
      let toolCalls: ToolCall[] | undefined;
      while (true) {
        const event = await session.events.next();
        controller.signal.throwIfAborted();
        if (event.type === 'error') throw event.error;
        if (event.type === 'end') break;
        if (event.type === 'tool') {
          outcome = event.call.function.name === 'proxy_approve_action' ? 'awaiting_approval' : 'awaiting_tool';
          toolCalls = [event.call];
          if (body.stream) await send(chunk({ tool_calls: [{ ...event.call, index: 0 }] }));
          break;
        }
        if (body.stream) await send(chunk({ content: event.text }));
        else content += event.text;
        if (event.type === 'approval') { outcome = 'awaiting_approval'; break; }
      }
      controller.signal.throwIfAborted();
      if (body.stream) {
        await send(chunk({}, toolCalls ? 'tool_calls' : 'stop'));
        await write(reply.raw, 'data: [DONE]\n\n');
        reply.raw.end();
      } else {
        return reply.send({ ...meta, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: content || (toolCalls ? null : ''), ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }] });
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      session?.cancel(error);
      const code = error instanceof ProxyError ? error.code : 'cli_error';
      outcome = code;
      errorCode = code;
      if (reply.raw.destroyed) return;
      if (reply.raw.headersSent) {
        try {
          await send(errorBody(error, code));
          await write(reply.raw, 'data: [DONE]\n\n');
        } catch { /* The client may have disconnected during the error write. */ }
        reply.raw.end();
      } else {
        return reply.code(error instanceof ProxyError ? error.statusCode : 502).send(errorBody(error, code));
      }
    } finally {
      request.log.info({ requestId: request.id, sessionId: session?.id, provider: context.profile.provider, modelId: body.model, workspaceId: context.workspaceId, durationMs: Date.now() - started, outcome, errorCode }, 'CLI request finished');
      if (session) session.busy = false;
      if (heartbeat) clearInterval(heartbeat);
      request.raw.off('aborted', disconnect);
      request.raw.off('close', requestClose);
      reply.raw.off('close', responseClose);
      active.delete(controller);
    }
  });
}
