import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { RunOptions } from './base.js';
import { secureEqual, SERVER_ROOT, validateExecution } from '../config.js';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// Native 1.4.10 uses Path; the documented tools use different argument names.
// Unknown tools and missing paths must never acquire a ServerRoot fallback.
function validateTool(input: unknown, root: string): { name: string; args: Record<string, unknown> } {
  if (!input || typeof input !== 'object' || !('toolCall' in input)) throw new Error('Invalid tool');
  const tool = input.toolCall as { name?: unknown; args?: unknown };
  if (!tool || typeof tool.name !== 'string' || !tool.args || typeof tool.args !== 'object' || Array.isArray(tool.args)) throw new Error('Invalid tool');
  const fields: Record<string, string> = { read_file: 'Path', write_file: 'Path', view_file: 'AbsolutePath', write_to_file: 'TargetFile', replace_file_content: 'TargetFile', multi_replace_file_content: 'TargetFile', run_command: 'Cwd' };
  const field = Object.hasOwn(fields, tool.name) ? fields[tool.name] : undefined;
  const args = tool.args as Record<string, unknown>;
  const path = field ? args[field] : undefined;
  if (typeof path !== 'string' || !isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error('Unverifiable tool path');
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(path) || /[:*?"<>|]/.test(path.slice(2)) || path.split(/[\\/]/).some(part => /[. ]$/.test(part) && part !== '.' && part !== '..'))) throw new Error('Ambiguous Windows path');
  const target = resolve(path);
  const inside = relative(root, target);
  if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) throw new Error('Tool path outside workspace');
  // New files are allowed only through existing canonical parents. Reject links,
  // including dangling links and junctions, before and after operator approval.
  let existing = target;
  for (;;) {
    try {
      if (lstatSync(existing).isSymbolicLink() || relative(existing, realpathSync(existing)) !== '') throw new Error('Redirected tool path');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existing); if (parent === existing) throw error; existing = parent;
    }
  }
  if (tool.name === 'run_command' && (typeof args.CommandLine !== 'string' || !args.CommandLine.trim())) throw new Error('Missing command');
  return { name: tool.name, args };
}

export async function createAgyApprovalBridge(options: RunOptions, validateHook: () => void = () => {}, requireReady = false) {
  const token = randomBytes(32).toString('hex');
  let ready = !requireReady;
  let conversation: string | undefined;
  let signalReady: () => void;
  const readyEvent = new Promise<void>(resolve => { signalReady = resolve; });
  if (ready) signalReady!();
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !['/approve', '/ready'].includes(request.url ?? '') || !secureEqual(request.headers.authorization ?? '', `Bearer ${token}`)) {
      response.writeHead(403).end(); return;
    }
    try {
      let text = '';
      for await (const chunk of request) {
        text += chunk.toString();
        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Hook input too large');
      }
      const input = JSON.parse(text);
      if (options.context) validateExecution(options.context);
      validateHook();
      if (request.url === '/ready') {
        if (!requireReady || options.signal.aborted || !options.context || !Array.isArray(input.workspacePaths) || input.workspacePaths.length !== 1 || realpathSync(input.workspacePaths[0]) !== options.context.workspaceRoot) throw new Error('Invalid readiness context');
        if (typeof input.conversationId !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.conversationId) || (conversation && conversation !== input.conversationId)) throw new Error('Invalid readiness session');
        conversation = input.conversationId;
        ready = true; signalReady!();
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"ready":true}'); return;
      }
      if (!ready) throw new Error('Hook loading not attested');
      if (!Array.isArray(input.workspacePaths) || input.workspacePaths.length !== 1 || realpathSync(input.workspacePaths[0]) !== (options.context?.workspaceRoot ?? SERVER_ROOT) || (requireReady && input.conversationId !== conversation)) throw new Error('Invalid tool context');
      if (options.signal.aborted || !input.toolCall || typeof input.toolCall.name !== 'string' || !input.toolCall.args || typeof input.toolCall.args !== 'object' || Array.isArray(input.toolCall.args)) throw new Error('Invalid hook payload');
      const tool = validateTool(input, options.context?.workspaceRoot ?? SERVER_ROOT);
      const args = tool.args;
      const approved = await options.onApproval!({
        action: `${input.toolCall.name}\n${JSON.stringify(args, null, 2)}`,
        cwd: options.context?.workingDirectory ?? SERVER_ROOT,
        reason: typeof args.Justification === 'string' ? args.Justification : 'Antigravity PreToolUse: action has not executed.',
      });
      validateHook();
      if (options.context) validateExecution(options.context);
      validateTool(input, options.context?.workspaceRoot ?? SERVER_ROOT);
      options.signal.throwIfAborted();
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ approved }));
    } catch {
      if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end('{"approved":false}');
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot start approval bridge');
  return {
    ready: readyEvent,
    isReady: () => ready,
    env: { CLI_PROXY_HOOK_URL: `http://127.0.0.1:${address.port}/approve`, CLI_PROXY_HOOK_TOKEN: token, CLI_PROXY_APPROVAL_TIMEOUT_MS: String(options.approvalTimeoutMs ?? 300_000) },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
