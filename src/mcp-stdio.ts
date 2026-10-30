import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/** Minimal MCP stdio adapter. Only structured forwarding; never executes client tools. */
export async function serveMcp(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const base = new URL(env.CLI_PROXY_MCP_URL ?? '');
  const token = env.CLI_PROXY_MCP_TOKEN, sessionId = env.CLI_PROXY_MCP_SESSION;
  const timeout = Number(env.CLI_PROXY_MCP_TIMEOUT_MS ?? 300000);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.pathname !== '/mcp/' || base.username || base.password || base.search || base.hash || !token || !sessionId || !env.CLI_PROXY_MCP_WORKSPACE || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 580000) throw new Error('MCP credentials unavailable');
  const workspace = realpathSync(env.CLI_PROXY_MCP_WORKSPACE);
  const peerId = randomUUID(); let peerLease: string | undefined;
  const utf8 = new StringDecoder('utf8');
  let initialized = false, buffered = '', closing = false;
  const calls = new Map<string | number, AbortController>(); const seen = new Set<string | number>();
  const jobs = new Set<Promise<void>>();
  const lifetime = new AbortController();
  const disconnected = () => { closing = true; lifetime.abort(new Error('MCP stdio disconnected')); };
  output.on('error', disconnected); output.on('close', disconnected);
  const send = (message: unknown) => { if (!closing) output.write(JSON.stringify(message) + '\n'); };
  const request = async (path: string, body: Record<string, unknown>, signal: AbortSignal) => {
    const response = await fetch(new URL(path, base), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, sessionId, workspace, peerId, ...(peerLease ? { peerLease } : {}) }), signal: AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(timeout)]), redirect: 'error' });
    if (!response.ok) throw new Error('MCP bridge rejected request');
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error('MCP response limit');
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  async function message(raw: string): Promise<void> {
    let m: any; try { m = JSON.parse(raw); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid MCP request' } }); return; }
    if (m.method === 'notifications/cancelled') { calls.get(m.params?.requestId)?.abort(new Error('MCP request cancelled')); return; }
    if (m.id === undefined) return;
    if ((typeof m.id !== 'string' && typeof m.id !== 'number') || seen.has(m.id) || seen.size >= 1024) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid or replayed request ID' } }); return; }
    seen.add(m.id); const controller = new AbortController(); calls.set(m.id, controller);
    try {
      let result: unknown;
      if (m.method === 'initialize') {
        if (initialized) throw new Error('Already initialized');
        const attached = await request('attach', { workerPid: process.pid }, controller.signal);
        if (typeof attached?.lease !== 'string') throw new Error('MCP worker lease unavailable');
        peerLease = attached.lease;
        initialized = true;
        const supported = ['2025-11-25', '2025-06-18', '2024-11-05'];
        result = { protocolVersion: supported.includes(m.params?.protocolVersion) ? m.params.protocolVersion : supported[0], capabilities: { tools: {} }, serverInfo: { name: 'obsidian-cli-proxy-tools', version: '1.0.0' } };
      } else if (!initialized) throw new Error('MCP initialization required');
      else if (m.method === 'ping') result = {};
      else if (m.method === 'tools/list') result = await request('list', { rpcId: m.id }, controller.signal);
      else if (m.method === 'tools/call') result = await request('call', { rpcId: m.id, requestId: randomUUID(), name: m.params?.name, arguments: m.params?.arguments ?? {}, nativeConversationId: m.params?._meta?.['antigravity.google/conversation_id'], nativeRootConversationId: m.params?._meta?.['antigravity.google/root_conversation_id'] }, controller.signal);
      else { send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Unsupported MCP method' } }); return; }
      send({ jsonrpc: '2.0', id: m.id, result });
    } catch { send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'MCP session or operation unavailable' } }); }
    finally { calls.delete(m.id); }
  }
  try {
    for await (const chunk of input) {
      buffered += typeof chunk === 'string' ? chunk : utf8.write(Buffer.from(chunk));
      const lines = buffered.split('\n'); buffered = lines.pop() ?? '';
      if (Buffer.byteLength(buffered) > 1024 * 1024) throw new Error('MCP frame limit');
      for (const line of lines) {
        if (Buffer.byteLength(line) > 1024 * 1024 || jobs.size >= 16) throw new Error('MCP request limit');
        if (!line.trim()) continue;
        const job = message(line); jobs.add(job); void job.finally(() => jobs.delete(job));
      }
    }
  } finally {
    disconnected(); await Promise.allSettled(jobs);
    if (peerLease) {
      // A terminal worker never reconnects to its old invocation. The bridge
      // may already be gone; that also leaves the old lease unusable.
      await fetch(new URL('detach', base), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, workspace, peerId, peerLease }), signal: AbortSignal.timeout(2000), redirect: 'error' }).catch(() => {});
    }
    output.off('error', disconnected); output.off('close', disconnected);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void serveMcp().catch(() => { process.stderr.write('MCP session unavailable.\n'); process.exitCode = 1; });
