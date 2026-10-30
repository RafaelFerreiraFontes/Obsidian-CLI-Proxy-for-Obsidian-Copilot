import { ProxyError } from '../types.js';
import { SpawnRunner, type Command, type OutputDecoder, type RunOptions } from './base.js';
import { createAgyApprovalBridge } from './agy-approval-bridge.js';
import { parseAgyModels } from '../models.js';
import { modelError } from '../utils/model-error.js';
import { authenticationError } from '../utils/cli-error.js';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { SERVER_ROOT, HOOK_ROOT } from '../config.js';
import { AgyWorkspaceRegistry } from '../agy-workspaces.js';
import { HookCredentialLease } from '../hook-credentials.js';
import { AgyLifecycle } from './agy-lifecycle.js';
import { createAgyMcpBridge, type NativeMcpInvocation } from './agy-mcp-bridge.js';
import { inspectAgyCapability } from './agy-capabilities.js';

export class AgyDecoder implements OutputDecoder {
  constructor(private onInit?: (id: unknown, cwd: unknown) => Promise<void>, private observe: (event: Record<string, unknown>) => void = () => {}) {}
  private initialization: Promise<void> | undefined;
  async beforeOutput(): Promise<void> { await this.initialization; }
  private pending = '';
  private receivedResult = false;
  private emitted = '';
  get completed(): boolean { return this.receivedResult; }

  push(text: string): string[] {
    this.pending += text;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    return lines.flatMap(line => this.line(line));
  }

  private line(line: string): string[] {
    if (!line.trim()) return [];
    let event;
    try { event = JSON.parse(line); }
    catch { throw new ProxyError('Antigravity emitted invalid stream-json output.', 502, 'cli_protocol_error'); }
    if (!event || typeof event !== 'object') throw new ProxyError('Antigravity emitted an invalid event.');
    if (event.event === 'init') {
      const tools = Array.isArray(event.init?.tools) ? event.init.tools.filter((name: unknown) => typeof name === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(name)).slice(0, 256) : [];
      this.observe({ event: 'agy_native_tools', tools });
    }
    if (event.event === 'step_update' && event.step_update?.step_type === 'tool') this.observe({ event: 'agy_native_tool_state', state: ['ACTIVE', 'DONE', 'ERROR'].includes(event.step_update.state) ? event.step_update.state : null });
    if (event.event === 'result') this.observe({ event: 'agy_native_result', status: event.result?.status === 'SUCCESS' ? 'SUCCESS' : 'ERROR' });
    if (event.event === 'init' && this.onInit) {
      if (this.initialization) throw new ProxyError('Antigravity emitted duplicate init events.', 502, 'cli_protocol_error');
      this.initialization = this.onInit(event.conversation_id, event.init?.cwd);
      // push may reject a later event in the same frame. Preserve the error for
      // beforeOutput while preventing an unhandled asynchronous rejection.
      void this.initialization.catch(() => {});
    }
    if (this.onInit && !this.initialization && (event.event === 'result' || event.step_update?.step_type === 'agent_response')) throw new ProxyError('Antigravity emitted a response before native init.', 502, 'cli_protocol_error');
    if (event.event === 'step_update' && event.step_update?.step_type === 'agent_response') {
      const delta = event.step_update.text_delta;
      if (typeof delta === 'string') { this.emitted += delta; return [delta]; }
    }
    if (event.event === 'result') {
      this.receivedResult = true;
      const result = event.result;
      if (result?.status !== 'SUCCESS') {
        const message = `Antigravity failed (${result?.status ?? 'unknown'}): ${typeof result?.error === 'string' ? result.error : JSON.stringify(result?.error ?? 'No diagnostic output.')}`;
        throw authenticationError(message) ?? modelError(message) ?? new ProxyError(message);
      }
      // Some versions emit only the final response. Never duplicate streamed deltas.
      if (!this.emitted && typeof result.response === 'string') {
        this.emitted = result.response;
        return [result.response];
      }
    }
    return [];
  }

  finish(): string[] {
    const tail = this.line(this.pending);
    this.pending = '';
    if (!this.receivedResult) throw new ProxyError('Antigravity closed without a result event.', 502, 'cli_protocol_error');
    if (!this.emitted.trim()) throw new ProxyError('Antigravity completed without an assistant response.', 502, 'cli_protocol_error');
    return tail;
  }
}

export class AgyRunner extends SpawnRunner {
  readonly clientToolsReady: boolean = false;
  readonly phasedTimeouts = true;
  private phaseClock: AgyLifecycle | undefined;
  private bridgeEnv: NodeJS.ProcessEnv | undefined;
  private lease: HookCredentialLease | undefined;
  private mcp: Awaited<ReturnType<typeof createAgyMcpBridge>> | undefined;

  async listModels(signal: AbortSignal): Promise<string[]> {
    class Discovery extends SpawnRunner {
      protected command(): Command { return { provider: 'agy', executable: this.config.executable ?? process.env.AGY_BIN ?? (process.platform === 'win32' ? 'agy.exe' : 'agy'), args: ['models'], input: '' }; }
    }
    let text = '';
    for await (const part of new Discovery({ ...this.config, cwd: SERVER_ROOT, maxOutputBytes: 1024 * 1024 }).run({ model: 'default', prompt: '', signal })) text += part;
    return parseAgyModels(text);
  }

  override async *run(options: RunOptions): AsyncGenerator<string> {
    if (options.tools?.length) this.assertClientToolSupport(options);
    if (!options.onApproval) throw new ProxyError('Antigravity requires an approval bridge.', 503, 'approval_hook_missing');
    // Use a per-invocation runner: shared provider instances serve concurrent requests.
    const cwd = options.context?.workingDirectory ?? this.config.cwd;
    if (!cwd) throw new ProxyError('An explicit authorized workspace is required.', 403, 'workspace_not_authorized');
    if (realpathSync(cwd) !== SERVER_ROOT) {
      if (!options.context) throw new ProxyError('External Antigravity execution requires an authorized session context.', 403, 'workspace_not_authorized');
      const registry = this.config.agyRegistry ?? new AgyWorkspaceRegistry();
      const context = options.context;
      registry.verify(context);
      const verify = () => { registry.verify(context); if (options.tools?.length) { if (!this.config.agyMcpRegistry) throw new ProxyError('Explicit MCP registration required.', 503, 'mcp_registration_failed'); this.config.agyMcpRegistry.verify(context); } };
      verify();
      this.assertExternalHookSupport(options);
      yield* this.runApproved(options, verify);
      return;
    }
    let hooks;
    try { hooks = JSON.parse(await readFile(join(HOOK_ROOT, 'hooks.json'), 'utf8')); }
    catch { throw new ProxyError('Antigravity hook configuration is unavailable or invalid.', 503, 'approval_hook_missing'); }
    const entry = hooks['obsidian-cli-proxy-approval'];
    const gate = entry?.PreToolUse?.some((rule: { matcher?: string; hooks?: Array<{ command?: string; type?: string }> }) => rule.matcher === '.*' && rule.hooks?.some(hook => hook.type === 'command' && hook.command === 'node approval-launcher.mjs'));
    if (!gate || entry.enabled === false) throw new ProxyError('Antigravity approval hook is missing, disabled or invalid in the server HookRoot. Verify .agents/hooks.json and run npm run build.', 503, 'approval_hook_missing');
    await access(join(HOOK_ROOT, 'approval-launcher.mjs')).catch(() => { throw new ProxyError('Approval launcher missing.', 503, 'approval_hook_missing'); });
    await access(join(SERVER_ROOT, 'dist', 'approval-hook.js')).catch(() => { throw new ProxyError('Build the Antigravity approval hook first with npm run build.', 503, 'approval_hook_missing'); });
    yield* this.runApproved(options);
  }

  protected assertClientToolSupport(_options: RunOptions): void {
    // Native single-session proof is insufficient to enable concurrent sessions
    // or external production execution. Only isolated test adapters override.
    throw new ProxyError('Antigravity client tools are unavailable.', 400, 'tool_not_supported');
  }

  protected assertExternalHookSupport(options?: RunOptions): void {
    // Static files and post-spawn attestation cannot prevent an action if the
    // native CLI ignores hooks. Keep production blocked until that contract is
    // verified for the entire production lifecycle. Isolated fixture/native
    // proof adapters override this gate without enabling production requests.
    const capability = inspectAgyCapability(options, options?.context?.profile.executable ?? this.config.executable ?? process.env.AGY_BIN ?? (process.platform === 'win32' ? 'agy.exe' : 'agy'), this.config.prefixArgs, { hooks: this.config.agyRegistry ?? new AgyWorkspaceRegistry(), mcp: this.config.agyMcpRegistry });
    throw new ProxyError(`External Antigravity execution is blocked: native hook loading has not been verified for the complete protected production lifecycle and concurrent sessions. Registration alone does not authorize execution. Capability blockers: ${capability.blockers.join(', ')}; reviewed binary: ${capability.checks.reviewedBinary}.`, 503, 'approval_hook_failed');
  }

  private async *runApproved(options: RunOptions, validateHook?: () => void) {
    const readiness = new AbortController();
    const scoped = { ...options, signal: AbortSignal.any([options.signal, readiness.signal]) };
    const clock = new AgyLifecycle(options.context?.profile ?? {}, error => readiness.abort(error), options.onPhase);
    const runner = new AgyRunner(this.config);
    let bridge: Awaited<ReturnType<typeof createAgyApprovalBridge>> | undefined;
    try {
      if (options.tools?.length) {
        if (!validateHook || !options.context) throw new ProxyError('Registered external MCP context required.', 503, 'mcp_registration_failed');
        runner.mcp = await createAgyMcpBridge({ ...scoped, onToolCall: async call => {
          clock.phase('waiting_tool');
          try { return await options.onToolCall!(call); }
          finally { if (!scoped.signal.aborted) clock.phase('active'); }
        } }, validateHook, this.config.agyMcpObserver, error => readiness.abort(error));
      }
      bridge = await createAgyApprovalBridge({ ...scoped, onApproval: async action => {
        clock.phase('waiting_approval');
        try { return await options.onApproval!(action); }
        finally { if (!scoped.signal.aborted) clock.phase('active'); }
      } }, validateHook, validateHook !== undefined, runner.mcp ? input => runner.mcp!.validateInvocation(input as NativeMcpInvocation) : undefined, runner.mcp ? (input, approved) => runner.mcp!.recordDecision(input as NativeMcpInvocation, approved) : undefined);
      void bridge.ready.then(() => clock.ready());
      runner.bridgeEnv = { ...bridge.env, ...runner.mcp?.env };
      runner.phaseClock = clock;
      if (validateHook && options.context) runner.lease = new HookCredentialLease(options.context, { url: bridge.env.CLI_PROXY_HOOK_URL!, token: bridge.env.CLI_PROXY_HOOK_TOKEN!, approvalTimeoutMs: options.approvalTimeoutMs ?? options.context.profile.approvalTimeoutMs ?? 300_000 });
      clock.phase('spawning');
      yield* runner.runWithBridge(scoped);
      runner.mcp?.assertIdle();
      if (!bridge.isReady()) throw new ProxyError('Antigravity hook loading was not attested.', 503, 'approval_hook_failed');
    } finally { clock.close(); try { await runner.mcp?.close(); } finally { try { await bridge?.close(); } finally { await runner.lease?.close(); } } }
  }

  private async *runWithBridge(options: RunOptions) { yield* super.run(options); }

  protected override errorFromStderr(stderr: string): ProxyError | undefined {
    if (/Authentication required|silent auth failed|Please sign in to view available models/i.test(stderr)) {
      return new ProxyError('Antigravity authentication is unavailable. Run agy interactively in your terminal to sign in, then restart the proxy with the same OS account and credential environment.', 502, 'cli_authentication_error');
    }
    return super.errorFromStderr(stderr);
  }

  protected command(options: RunOptions): Command {
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands'];
    // AGY's default project is independent of process.cwd(); mount the authorized root.
    if (options.context) args.push('--add-dir', options.context.workspaceRoot);
    if (options.model !== 'default') args.push('--model', options.model);
    return {
      provider: 'agy',
      keepStdinOpen: true,
      ...(this.phaseClock ? { managesStartup: true, onSpawn: (pid: number) => { this.mcp?.bindProcess(pid); this.phaseClock!.spawned(); } } : {}),
      executable: this.config.executable ?? process.env.AGY_BIN ?? (process.platform === 'win32' ? 'agy.exe' : 'agy'),
      args,
      input: JSON.stringify({ event: 'user', message: { content: options.prompt } }) + '\n',
      decoder: new AgyDecoder(this.phaseClock ? async (id, cwd) => {
        if (typeof id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) || typeof cwd !== 'string' || realpathSync(cwd) !== realpathSync(options.context?.workspaceRoot ?? this.config.cwd!)) throw new ProxyError('Antigravity init does not match the authorized workspace.', 502, 'cli_protocol_error');
        await this.lease?.register(id, cwd); this.mcp?.bindNative(id, cwd); this.phaseClock!.init();
      } : undefined, this.config.agyMcpObserver),
      ...(this.bridgeEnv ? { env: this.bridgeEnv } : {}),
    };
  }
}
