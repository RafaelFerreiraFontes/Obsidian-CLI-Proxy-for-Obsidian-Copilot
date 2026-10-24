import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { CliRunner } from './providers/base.js';
import { ProxyError, errorBody, type ChatCompletionChunk, type ChatCompletionRequest, type Model } from './types.js';
import { formatPrompt } from './utils/prompt-formatter.js';

export interface RouteOptions {
  providers: Record<'codex' | 'agy', CliRunner>;
  modelIds?: string[];
  timeoutMs?: number;
}

const bodySchema = {
  type: 'object', required: ['model', 'messages'], additionalProperties: true,
  properties: {
    model: { type: 'string', pattern: '^(codex|agy)/[^\\s]+$', maxLength: 200 },
    messages: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', required: ['role', 'content'], additionalProperties: true,
        properties: {
          role: { type: 'string', enum: ['system', 'developer', 'user', 'assistant'] },
          content: { anyOf: [
            { type: 'string' },
            { type: 'array', items: {
              type: 'object', required: ['type', 'text'], additionalProperties: false,
              properties: { type: { const: 'text' }, text: { type: 'string' } },
            } },
          ] },
        },
      },
    },
    stream: { type: 'boolean' },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    stream_options: { type: 'object', properties: { include_usage: { type: 'boolean' } } },
    tools: { type: 'array', maxItems: 0 },
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
  app.addHook('preClose', async () => {
    for (const controller of active) controller.abort(new ProxyError('Server is shutting down.', 503, 'server_shutdown'));
  });
  const created = Math.floor(Date.now() / 1000);
  const modelIds = [...new Set(['codex/default', 'agy/default', ...(options.modelIds ?? [])])];
  const models: Model[] = modelIds.filter(id => /^(codex|agy)\/\S+$/.test(id)).map(id => ({
    id, object: 'model', created, owned_by: id.split('/')[0]!,
  }));

  app.get('/health', async () => ({ status: 'ok', active_requests: active.size }));
  app.get('/v1/models', async () => ({ object: 'list', data: models }));

  app.post<{ Body: ChatCompletionRequest }>('/v1/chat/completions', { schema: { body: bodySchema } }, async (request, reply) => {
    const body = request.body;
    const slash = body.model.indexOf('/');
    const provider = options.providers[body.model.slice(0, slash) as 'codex' | 'agy'];
    const controller = new AbortController();
    active.add(controller);
    const disconnect = () => controller.abort(new ProxyError('Client disconnected.', 499, 'client_disconnected'));
    // IncomingMessage close also fires for a normally consumed request body in modern Node.
    const requestClose = () => { if (request.raw.aborted || !request.raw.complete) disconnect(); };
    const responseClose = () => { if (!reply.raw.writableFinished) disconnect(); };
    request.raw.on('aborted', disconnect);
    request.raw.on('close', requestClose);
    reply.raw.on('close', responseClose);
    if (request.raw.aborted || reply.raw.destroyed) disconnect();
    const timeout = setTimeout(() => controller.abort(new ProxyError('CLI request timed out.', 504, 'cli_timeout')), options.timeoutMs ?? 120_000);
    timeout.unref();
    let heartbeat: NodeJS.Timeout | undefined;
    const meta = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: body.model };
    const chunk = (delta: { role?: 'assistant'; content?: string }, finish: 'stop' | null = null): ChatCompletionChunk => ({
      ...meta, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const send = (data: unknown) => write(reply.raw, `data: ${JSON.stringify(data)}\n\n`);
    try {
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
      for await (const part of provider.run({ model: body.model.slice(slash + 1), prompt: formatPrompt(body.messages), signal: controller.signal })) {
        controller.signal.throwIfAborted();
        if (body.stream) await send(chunk({ content: part }));
        else content += part;
      }
      controller.signal.throwIfAborted();
      if (body.stream) {
        await send(chunk({}, 'stop'));
        await write(reply.raw, 'data: [DONE]\n\n');
        reply.raw.end();
      } else {
        return reply.send({ ...meta, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const code = error instanceof ProxyError ? error.code : 'cli_error';
      if (reply.raw.destroyed) return;
      if (body.stream) {
        try {
          await send(errorBody(error, code));
          await write(reply.raw, 'data: [DONE]\n\n');
        } catch { /* The client may have disconnected during the error write. */ }
        reply.raw.end();
      } else {
        return reply.code(error instanceof ProxyError ? error.statusCode : 502).send(errorBody(error, code));
      }
    } finally {
      clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      request.raw.off('aborted', disconnect);
      request.raw.off('close', requestClose);
      reply.raw.off('close', responseClose);
      active.delete(controller);
    }
  });
}
