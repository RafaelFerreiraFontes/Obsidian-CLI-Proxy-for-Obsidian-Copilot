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

export class AgyDecoder implements OutputDecoder {
  constructor(private onInit?: (id: unknown, cwd: unknown) => Promise<void>) {}
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
    if (event.event === 'init' && event.conversation_id && this.onInit) this.initialization = this.onInit(event.conversation_id, event.init?.cwd);
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
  private bridgeEnv: NodeJS.ProcessEnv | undefined;
  private lease: HookCredentialLease | undefined;

  async listModels(signal: AbortSignal): Promise<string[]> {
    class Discovery extends SpawnRunner {
      protected command(): Command { return { provider: 'agy', executable: this.config.executable ?? process.env.AGY_BIN ?? (process.platform === 'win32' ? 'agy.exe' : 'agy'), args: ['models'], input: '' }; }
    }
    let text = '';
    for await (const part of new Discovery({ ...this.config, cwd: SERVER_ROOT, maxOutputBytes: 1024 * 1024 }).run({ model: 'default', prompt: '', signal })) text += part;
    return parseAgyModels(text);
  }

  override async *run(options: RunOptions): AsyncGenerator<string> {
    if (options.tools?.length) throw new ProxyError('Antigravity client tools are unavailable.', 400, 'tool_not_supported');
    if (!options.onApproval) throw new ProxyError('Antigravity requires an approval bridge.', 503, 'approval_hook_missing');
    // Use a per-invocation runner: shared provider instances serve concurrent requests.
    const cwd = options.context?.workingDirectory ?? this.config.cwd;
    if (!cwd) throw new ProxyError('An explicit authorized workspace is required.', 403, 'workspace_not_authorized');
    if (realpathSync(cwd) !== SERVER_ROOT) {
      if (!options.context) throw new ProxyError('External Antigravity execution requires an authorized session context.', 403, 'workspace_not_authorized');
      const registry = this.config.agyRegistry ?? new AgyWorkspaceRegistry();
      const context = options.context;
      registry.verify(context);
      this.assertExternalHookSupport();
      yield* this.runApproved(options, () => registry.verify(context));
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

  protected assertExternalHookSupport(): void {
    // Static files and post-spawn attestation cannot prevent an action if the
    // native CLI ignores hooks. Keep production blocked until that contract is
    // verified. Only the simulated CLI adapter in tests overrides this gate.
    throw new ProxyError('External Antigravity execution is blocked: native hook loading has not been verified. Registration alone does not authorize execution.', 503, 'approval_hook_failed');
  }

  private async *runApproved(options: RunOptions, validateHook?: () => void) {
    const readiness = new AbortController();
    const scoped = { ...options, signal: AbortSignal.any([options.signal, readiness.signal]) };
    const bridge = await createAgyApprovalBridge(scoped, validateHook, validateHook !== undefined);
    const timer = setTimeout(() => readiness.abort(new ProxyError('Antigravity did not attest loading the registered startup hooks.', 503, 'approval_hook_failed')), options.context?.profile.startupTimeoutMs ?? 30_000);
    timer.unref();
    void bridge.ready.then(() => clearTimeout(timer));
    const runner = new AgyRunner(this.config);
    runner.bridgeEnv = bridge.env;
    if (validateHook && options.context) runner.lease = new HookCredentialLease(options.context, { url: bridge.env.CLI_PROXY_HOOK_URL!, token: bridge.env.CLI_PROXY_HOOK_TOKEN! });
    try {
      yield* runner.runWithBridge(scoped);
      if (!bridge.isReady()) throw new ProxyError('Antigravity hook loading was not attested.', 503, 'approval_hook_failed');
    } finally { clearTimeout(timer); try { await bridge.close(); } finally { await runner.lease?.close(); } }
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
      executable: this.config.executable ?? process.env.AGY_BIN ?? (process.platform === 'win32' ? 'agy.exe' : 'agy'),
      args,
      input: JSON.stringify({ event: 'user', message: { content: options.prompt } }) + '\n',
      decoder: new AgyDecoder(this.lease ? (id, cwd) => this.lease!.register(id, cwd) : undefined),
      ...(this.bridgeEnv ? { env: this.bridgeEnv } : {}),
    };
  }
}
