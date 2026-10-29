import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ProxyError, type ToolCall } from '../types.js';
import { killProcessTree, type RunOptions, type RunnerConfig } from './base.js';
import { AsyncQueue } from '../utils/async-queue.js';
import { AnsiFilter } from '../utils/ansi.js';
import { modelError } from '../utils/model-error.js';
import { cliEnvironment, validateExecution } from '../config.js';
import { authenticationError } from '../utils/cli-error.js';

type Event = { type: 'message'; value: Record<string, any> } | { type: 'error'; error: Error } | { type: 'closed'; code: number | null };

// One app-server per active agent turn. Its JSON-RPC request remains pending across chat replies.
export async function* runCodexAppServer(options: RunOptions, config: RunnerConfig): AsyncGenerator<string> {
  options.signal.throwIfAborted();
  if (options.context) validateExecution(options.context);
  const cwd = options.context?.workingDirectory ?? config.cwd;
  if (!cwd) throw new ProxyError('An explicit authorized workspace is required.', 403, 'workspace_not_authorized');
  const policy = options.context?.profile.policy ?? 'read-only';
  const executable = options.context?.profile.executable ?? config.executable ?? process.env.CODEX_BIN ?? 'codex';
  const child = spawn(executable, [...(config.prefixArgs ?? []), 'app-server', '--listen', 'stdio://'], {
    cwd, shell: false, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    env: cliEnvironment('codex'),
  });
  const events = new AsyncQueue<Event>();
  const startup = setTimeout(() => {
    events.push({ type: 'error', error: new ProxyError('Codex initialization timed out.', 504, 'cli_timeout') });
    killProcessTree(child);
  }, options.context?.profile.startupTimeoutMs ?? 30_000);
  startup.unref();
  const closed = new Promise<void>(resolve => {
    child.once('close', code => { events.push({ type: 'closed', code }); resolve(); });
    child.once('error', error => { events.push({ type: 'error', error }); resolve(); });
  });
  const abort = () => killProcessTree(child);
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  let stderr = '';
  let bytes = 0;
  const ansi = new AnsiFilter();
  const textAnsi = new AnsiFilter();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => { stderr = (stderr + ansi.push(text)).slice(-16384); });
  child.stdin.on('error', () => {});
  let outputExceeded = false;
  child.stdout.on('data', (data: Buffer) => {
    bytes += data.length;
    if (!outputExceeded && bytes > (options.context?.profile.maxOutputBytes ?? config.maxOutputBytes ?? 8 * 1024 * 1024)) {
      outputExceeded = true;
      events.push({ type: 'error', error: new ProxyError('Codex output exceeded the configured limit.', 502, 'output_limit') });
      killProcessTree(child);
    }
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    if (outputExceeded) return;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object') throw new Error();
      events.push({ type: 'message', value });
    } catch { events.push({ type: 'error', error: new ProxyError('Codex emitted invalid JSON-RPC output.', 502, 'cli_protocol_error') }); }
  });
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
  const items = new Map<string, unknown>();
  let threadId: string | undefined;
  let turnError: string | undefined;
  let emitted = '';
  try {
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'obsidian_cli_proxy', version: '1.0.0' }, capabilities: { experimentalApi: true } } });
    while (true) {
      const event = await events.next();
      options.signal.throwIfAborted();
      if (event.type === 'error') {
        const missing = (event.error as NodeJS.ErrnoException).code === 'ENOENT';
        throw missing ? new ProxyError(`Cannot start ${executable}: ${event.error.message}`, 503, 'cli_not_found') : event.error;
      }
      if (event.type === 'closed') {
        const message = stderr.trim().slice(-4000) || `Codex app-server exited with code ${event.code} before completing the turn.`;
        throw authenticationError(message) ?? modelError(message) ?? new ProxyError(message);
      }
      const message = event.value;
      if (message.error) {
        const text = String(message.error.message ?? JSON.stringify(message.error));
        throw authenticationError(text) ?? modelError(text) ?? new ProxyError(text);
      }
      if (message.id === 1 && !message.method) {
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'thread/start', params: {
          ...(options.model === 'default' ? {} : { model: options.model }),
          allowProviderModelFallback: false,
          cwd, ephemeral: true,
          approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: policy === 'write-enabled' ? 'workspace-write' : 'read-only',
          ...(options.tools?.length ? { dynamicTools: options.tools.filter(tool => tool.function.name !== 'proxy_approve_action').map(tool => ({
            type: 'function', name: tool.function.name, description: tool.function.description ?? '',
            inputSchema: tool.function.parameters ?? { type: 'object', properties: {} },
          })) } : {}),
        } });
      } else if (message.id === 2 && !message.method) {
        clearTimeout(startup);
        threadId = message.result?.thread?.id;
        if (!threadId) throw new ProxyError('Codex did not return a thread ID.', 502, 'cli_protocol_error');
        send({ id: 3, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: options.prompt }] } });
      } else if (message.method) {
        const params = message.params ?? {};
        if (params.threadId && threadId && params.threadId !== threadId) continue;
        if (message.method === 'item/started' && params.item?.id) items.set(params.item.id, params.item);
        if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          const text = textAnsi.push(params.delta);
          emitted += text;
          if (text) yield text;
        } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method) && message.id !== undefined) {
          const item = items.get(params.itemId) as Record<string, unknown> | undefined;
          const action = {
            command: params.command ?? item?.command, changes: item?.changes,
            permissions: params.additionalPermissions, network: params.networkApprovalContext,
            grantRoot: params.grantRoot, policyAmendment: params.proposedExecpolicyAmendment,
          };
          if (!Object.values(action).some(value => value !== undefined && value !== null)) throw new ProxyError('Codex requested approval without an action preview.', 502, 'cli_protocol_error');
          const approved = await options.onApproval!({
            action: JSON.stringify(action, null, 2),
            ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : { cwd }),
            reason: typeof params.reason === 'string' ? params.reason : message.method,
          });
          options.signal.throwIfAborted();
          send({ id: message.id, result: { decision: approved ? 'accept' : 'decline' } });
        } else if (message.method === 'item/tool/call' && message.id !== undefined) {
          const name = String(params.tool);
          if (name === 'proxy_approve_action' || !options.tools?.some(tool => tool.function.name === name) || !options.onToolCall) {
            send({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: 'Tool is not registered by the client.' }] } });
          } else {
            const call: ToolCall = { id: String(params.callId), type: 'function', function: { name, arguments: JSON.stringify(params.arguments ?? {}) } };
            const output = await options.onToolCall(call);
            options.signal.throwIfAborted();
            send({ id: message.id, result: { success: true, contentItems: [{ type: 'inputText', text: output }] } });
          }
        } else if (message.id !== undefined) {
          // Never silently grant an unsupported permission/input/elicitation request.
          send({ id: message.id, error: { code: -32601, message: 'This interactive request is not supported by the proxy.' } });
        } else if (message.method === 'error') {
          turnError = String(params.error?.message ?? 'Codex turn failed.');
        } else if (message.method === 'turn/completed') {
          if (params.turn?.status !== 'completed') {
            const text = turnError ?? params.turn?.error?.message ?? `Codex turn ${params.turn?.status ?? 'failed'}.`;
            throw authenticationError(text) ?? modelError(text) ?? new ProxyError(text);
          }
          if (!emitted) {
            const text = (params.turn.items ?? []).filter((item: any) => item.type === 'agentMessage').map((item: any) => item.text ?? '').join('');
            if (text) yield textAnsi.push(text);
          }
          return;
        }
      }
    }
  } finally {
    clearTimeout(startup);
    options.signal.removeEventListener('abort', abort);
    lines.close();
    child.stdin.end();
    killProcessTree(child);
    await closed;
  }
}
