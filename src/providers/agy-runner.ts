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

export class AgyDecoder implements OutputDecoder {
  private pending = '';
  private receivedResult = false;
  private emitted = '';

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
    return tail;
  }
}

export class AgyRunner extends SpawnRunner {
  private bridgeEnv: NodeJS.ProcessEnv | undefined;

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
    if (realpathSync(cwd) !== SERVER_ROOT) throw new ProxyError('Antigravity external workspace is blocked: this CLI has no verified per-invocation hook configuration. No files were installed in the workspace.', 503, 'approval_hook_missing');
    let hooks;
    try { hooks = JSON.parse(await readFile(join(HOOK_ROOT, 'hooks.json'), 'utf8')); }
    catch { throw new ProxyError('Antigravity hook configuration is unavailable or invalid.', 503, 'approval_hook_missing'); }
    const entry = hooks['obsidian-cli-proxy-approval'];
    const gate = entry?.PreToolUse?.some((rule: { matcher?: string; hooks?: Array<{ command?: string; type?: string }> }) => rule.matcher === '.*' && rule.hooks?.some(hook => hook.type === 'command' && hook.command === 'node approval-launcher.mjs'));
    if (!gate || entry.enabled === false) throw new ProxyError('Antigravity approval hook is missing, disabled or invalid in the server HookRoot. Verify .agents/hooks.json and run npm run build.', 503, 'approval_hook_missing');
    await access(join(HOOK_ROOT, 'approval-launcher.mjs')).catch(() => { throw new ProxyError('Approval launcher missing.', 503, 'approval_hook_missing'); });
    await access(join(SERVER_ROOT, 'dist', 'approval-hook.js')).catch(() => { throw new ProxyError('Build the Antigravity approval hook first with npm run build.', 503, 'approval_hook_missing'); });
    const bridge = await createAgyApprovalBridge(options);
    const runner = new AgyRunner(this.config);
    runner.bridgeEnv = bridge.env;
    try { yield* runner.runWithBridge(options); }
    finally { await bridge.close(); }
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
    if (options.model !== 'default') args.push('--model', options.model);
    return {
      provider: 'agy',
      executable: this.config.executable ?? process.env.AGY_BIN ?? (process.platform === 'win32' ? 'agy.exe' : 'agy'),
      args,
      input: JSON.stringify({ event: 'user', message: { content: options.prompt } }) + '\n',
      decoder: new AgyDecoder(),
      ...(this.bridgeEnv ? { env: this.bridgeEnv } : {}),
    };
  }
}
