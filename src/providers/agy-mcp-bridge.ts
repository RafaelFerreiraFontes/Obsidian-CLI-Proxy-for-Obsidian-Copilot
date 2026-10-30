import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { Ajv } from 'ajv';
import { secureEqual, validateExecution } from '../config.js';
import { ProxyError, type ToolCall } from '../types.js';
import type { RunOptions } from './base.js';
import { processWitness, type ProcessWitness } from './agy-process-witness.js';

export const MCP_SERVER_NAME = 'obsidian-cli-proxy-tools';
export interface NativeMcpInvocation { toolCall?: { name?: string; args?: Record<string, unknown> }; conversationId?: string; workspacePaths?: string[] }
const MAX = 1024 * 1024;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export async function boundedWait<T>(work: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  signal.throwIfAborted();
  let timer: NodeJS.Timeout | undefined, abort: () => void = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new Error('Cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new ProxyError('MCP tool result timed out.', 504, 'tool_timeout')), ms);
    })]);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
function boundedJson(value: unknown): void {
  let nodes = 0;
  const visit = (v: unknown, depth: number) => {
    if (++nodes > 10000 || depth > 32) throw new Error('JSON structure limit');
    if (v && typeof v === 'object') for (const child of Object.values(v)) visit(child, depth + 1);
  };
  if (Buffer.byteLength(JSON.stringify(value)) > MAX) throw new Error('JSON size limit');
  visit(value, 0);
}
function actionKey(name: string, args: unknown): string {
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return digest(JSON.stringify([name, canonical(args)]));
}

/** Per authenticated invocation. No global catalog, workspace lookup, or tool execution. */
export async function createAgyMcpBridge(options: RunOptions, verify: () => void, observe: (event: Record<string, unknown>) => void = () => {}, fatal: (error: Error) => void = () => {}, witness: ProcessWitness = processWitness()) {
  if (!options.context || typeof options.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(options.sessionId) || !options.onToolCall || !options.tools || options.tools.length > 128) throw new Error('Explicit MCP session required');
  const context = options.context;
  boundedJson(options.tools);
  const snapshot = () => JSON.stringify({ context, model: options.model, tools: options.tools, sessionId: options.sessionId });
  const binding = snapshot(), openaiSessionId = options.sessionId;
  validateExecution(context); verify();
  const tools = structuredClone(options.tools.filter(t => t.function.name !== 'proxy_approve_action'));
  const validators = new Map<string, ReturnType<Ajv['compile']>>();
  for (const tool of tools) {
    const name = tool.function.name;
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(name) || validators.has(name)) throw new Error('Invalid or duplicate tool name');
    const schema = tool.function.parameters ?? { type: 'object', properties: {} };
    boundedJson(schema);
    if (Buffer.byteLength(JSON.stringify(schema)) > 65536 || schema.$async || (schema.type !== undefined && schema.type !== 'object')) throw new Error('Unsupported tool schema');
    validators.set(name, new Ajv({ strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false, allErrors: false }).compile(schema));
  }
  const token = randomBytes(32).toString('hex'), sessionId = randomUUID();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  let conversation: string | undefined, processId: number | undefined, busy = false;
  let peer: { id: string; pid: number; lease: string } | undefined;
  let verifyProcess: (() => Promise<void>) | undefined, attaching = false, spawnedAt = 0;
  let admission: { key: string; until: number } | undefined;
  let resolveBinding!: () => void;
  const nativeBinding = new Promise<void>(resolve => { resolveBinding = resolve; });
  const seen = new Set<string>(), rpcIds = new Set<string>();
  const correlation = () => ({ sessionHash: digest(sessionId), openaiSessionHash: digest(openaiSessionId), conversationHash: conversation ? digest(conversation) : null, processId: processId ?? null, peerHash: peer ? digest(peer.id) : null, workerPid: peer?.pid ?? null, leaseHash: peer ? digest(peer.lease) : null });
  const check = (requireNative = true) => { signal.throwIfAborted(); validateExecution(context); verify(); if (snapshot() !== binding) throw new Error('MCP session binding changed'); if (requireNative && (!conversation || !processId)) throw new Error('Native init not correlated'); };
  const revoke = (code: string, fail = busy) => { admission = undefined; const error = new ProxyError('MCP worker lease ended; requests are no longer authorized.', 502, code); lifetime.abort(error); if (fail) fatal(error); };
  const validArgs = (name: unknown, args: unknown) => {
    if (typeof name !== 'string' || !validators.has(name) || !args || typeof args !== 'object' || Array.isArray(args)) return false;
    boundedJson(args); return validators.get(name)!(args) === true;
  };
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.headers.origin || !['/mcp/attach', '/mcp/detach', '/mcp/list', '/mcp/call'].includes(request.url ?? '') || !secureEqual(request.headers.authorization ?? '', `Bearer ${token}`)) { response.writeHead(403).end(); return; }
    const call = new AbortController(); let pending = false, stage = 'request';
    const disconnected = () => { if (!response.writableFinished) { const error = new ProxyError('MCP peer disconnected.', 502, 'mcp_disconnected'); call.abort(error); if (pending) fatal(error); } };
    response.on('close', disconnected);
    try {
      request.setEncoding('utf8');
      let raw = ''; for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > MAX) throw new Error('MCP input limit'); }
      const input = JSON.parse(raw);
      check(false);
      if (input.sessionId !== sessionId || typeof input.workspace !== 'string' || realpathSync(input.workspace) !== context.workspaceRoot) throw new Error('Foreign MCP session');
      if (request.url === '/mcp/attach') {
        if (!uuid(input.peerId) || !Number.isSafeInteger(input.workerPid) || input.workerPid <= 0) throw new Error('Invalid MCP worker');
        if (peer || attaching) { revoke('mcp_peer_reused', true); throw new Error('Worker restart or reuse requires a new invocation'); }
        if (!processId) throw new Error('Native process not bound');
        attaching = true;
        try { verifyProcess = await witness(processId, input.workerPid, spawnedAt, signal); check(false); if (response.destroyed) throw new Error('MCP worker disconnected'); }
        catch { revoke('mcp_process_unverified', true); throw new Error('MCP process ownership unavailable'); }
        finally { attaching = false; }
        peer = { id: input.peerId, pid: input.workerPid, lease: randomBytes(32).toString('hex') };
        observe({ event: 'mcp_worker_attached', ...correlation(), workerPid: peer.pid });
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ lease: peer.lease })); return;
      }
      if (!peer || input.peerId !== peer.id || !secureEqual(typeof input.peerLease === 'string' ? input.peerLease : '', peer.lease)) throw new Error('Foreign or detached MCP worker');
      if (request.url === '/mcp/detach') { observe({ event: 'mcp_worker_detached', ...correlation() }); revoke('mcp_peer_detached'); response.writeHead(200).end('{}'); return; }
      // MCP discovery can precede stdout init delivery. Wait without exposing a
      // catalog; absent/invalid init, cancellation and close still reject it.
      if (request.url === '/mcp/list' && !conversation) await boundedWait(nativeBinding, AbortSignal.any([signal, call.signal]), context.profile.initTimeoutMs ?? 30000);
      check();
      stage = 'process-before';
      await verifyProcess!(); check(); call.signal.throwIfAborted();
      stage = 'request';
      if (!((typeof input.rpcId === 'string' && input.rpcId.length > 0 && input.rpcId.length <= 128) || (typeof input.rpcId === 'number' && Number.isSafeInteger(input.rpcId)))) throw new Error('Invalid MCP RPC ID');
      const rpcId = JSON.stringify([typeof input.rpcId, input.rpcId]);
      if (rpcIds.has(rpcId) || rpcIds.size >= 1024) throw new Error('Replayed MCP RPC ID');
      let result: unknown;
      if (request.url === '/mcp/list') {
        rpcIds.add(rpcId);
        observe({ event: 'mcp_tools_list', ...correlation(), rpcHash: digest(rpcId) });
        result = { tools: tools.map(t => ({ name: t.function.name, description: t.function.description ?? '', inputSchema: t.function.parameters ?? { type: 'object', properties: {} } })) };
      } else {
        // Observed AGY tools/call metadata identifies the native conversation;
        // discovery has no such field. A PID/cwd alone is never a call identity.
        if (!uuid(input.nativeConversationId) || input.nativeConversationId !== conversation || input.nativeRootConversationId !== conversation) throw new Error('Foreign or absent native MCP call identity');
        if (!uuid(input.requestId) || seen.has(input.requestId) || seen.size >= 1024 || busy || !validArgs(input.name, input.arguments)) throw new Error('Invalid/replayed/concurrent MCP action');
        if (admission && admission.until < Date.now()) admission = undefined;
        if (!admission || admission.key !== actionKey(input.name, input.arguments)) throw new Error('No matching single-action approval');
        admission = undefined; // Consume before publishing a client tool call.
        seen.add(input.requestId); rpcIds.add(rpcId); busy = true; pending = true;
        const actionCorrelation = { ...correlation(), requestHash: digest(input.requestId), rpcHash: digest(rpcId), nativeConversationHash: digest(input.nativeConversationId), nativeRootConversationHash: digest(input.nativeRootConversationId), tool: input.name };
        observe({ event: 'mcp_tool_pending', ...actionCorrelation });
        const toolCall: ToolCall = { id: `mcp_${input.requestId}`, type: 'function', function: { name: input.name, arguments: JSON.stringify(input.arguments) } };
        stage = 'client-result';
        const output = await boundedWait(options.onToolCall!(toolCall), AbortSignal.any([signal, call.signal]), context.profile.toolTimeoutMs ?? 300000);
        stage = 'context-after'; check(); stage = 'process-after'; await verifyProcess!(); check(); call.signal.throwIfAborted();
        if (typeof output !== 'string' || Buffer.byteLength(output) > MAX) throw new Error('MCP output limit');
        observe({ event: 'mcp_tool_resolved', ...actionCorrelation });
        result = { content: [{ type: 'text', text: output }], isError: false };
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (cause) {
      const code = cause instanceof ProxyError && ['mcp_process_unverified', 'tool_timeout', 'mcp_disconnected'].includes(cause.code) ? cause.code : signal.aborted ? 'session_revoked' : 'validation_failed';
      observe({ event: 'mcp_action_rejected', ...correlation(), stage, code });
      if (pending) revoke('mcp_session_failed', true);
      if (!response.destroyed) response.writeHead(409, { 'content-type': 'application/json' }).end('{"error":"MCP action rejected or unavailable"}');
    } finally { if (pending) busy = false; pending = false; response.off('close', disconnected); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('MCP bridge unavailable');
  return {
    env: { CLI_PROXY_MCP_URL: `http://127.0.0.1:${address.port}/mcp/`, CLI_PROXY_MCP_TOKEN: token, CLI_PROXY_MCP_SESSION: sessionId, CLI_PROXY_MCP_TIMEOUT_MS: String(context.profile.toolTimeoutMs ?? 300000) },
    bindProcess(pid: number): void {
      check(false);
      if (!Number.isSafeInteger(pid) || pid <= 0 || (processId && processId !== pid)) throw new Error('Invalid native process binding');
      processId = pid;
      if (!spawnedAt) spawnedAt = Date.now();
    },
    bindNative(id: unknown, cwd: unknown): void {
      check(false);
      if (!processId || !uuid(id) || typeof cwd !== 'string' || realpathSync(cwd) !== context.workspaceRoot || (conversation && conversation !== id)) throw new Error('Invalid native MCP binding');
      conversation = id; resolveBinding();
      observe({ event: 'mcp_native_bound', ...correlation() });
    },
    validateInvocation(input: NativeMcpInvocation): boolean {
      check();
      const args = input.toolCall?.args;
      if (input.conversationId !== conversation || input.workspacePaths?.length !== 1 || realpathSync(input.workspacePaths[0]!) !== context.workspaceRoot || input.toolCall?.name !== 'call_mcp_tool' || args?.ServerName !== MCP_SERVER_NAME) return false;
      let value = args.Arguments; if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return false; } }
      return validArgs(args.ToolName, value);
    },
    recordDecision(input: NativeMcpInvocation, approved: boolean): void {
      // Trusted bridge callback only. There is no HTTP endpoint to mint grants.
      check();
      const args = input.toolCall?.args;
      if (input.conversationId !== conversation || input.workspacePaths?.length !== 1 || realpathSync(input.workspacePaths[0]!) !== context.workspaceRoot || input.toolCall?.name !== 'call_mcp_tool' || args?.ServerName !== MCP_SERVER_NAME) throw new Error('Invalid approval context');
      let value = args.Arguments; if (typeof value === 'string') value = JSON.parse(value);
      if (!validArgs(args.ToolName, value)) throw new Error('Invalid MCP approval arguments');
      if (!approved) { admission = undefined; return; }
      if (admission && admission.until < Date.now()) admission = undefined;
      if (!peer || admission || busy) throw new Error('Invalid or concurrent MCP approval');
      admission = { key: actionKey(String(args.ToolName), value), until: Date.now() + 30000 };
      observe({ event: 'mcp_action_admitted', ...correlation(), tool: args.ToolName });
    },
    assertIdle(): void { if (busy) throw new ProxyError('AGY ended with an orphaned MCP tool call.', 502, 'mcp_orphaned_call'); },
    async close() { revoke('mcp_session_closed', false); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
