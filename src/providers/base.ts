import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { ProxyError } from '../types.js';
import { AnsiFilter } from '../utils/ansi.js';
import { modelError } from '../utils/model-error.js';
import { authenticationError } from '../utils/cli-error.js';
import type { OpenAITool, ToolCall } from '../types.js';
import { cliEnvironment, SERVER_ROOT, validateExecution, type ExecutionContext } from '../config.js';
import type { AgyWorkspaceRegistry } from '../agy-workspaces.js';
import type { AgyMcpWorkspaceRegistry } from '../agy-mcp-workspaces.js';
import type { ExecutionPhase } from './agy-lifecycle.js';

export interface ApprovalRequest {
  action: string;
  cwd?: string;
  reason?: string;
}

export interface RunOptions {
  /** Trusted AgentSession identity, never copied from a client header or prompt. */
  sessionId?: string;
  context?: ExecutionContext;
  approvalTimeoutMs?: number;
  model: string;
  prompt: string;
  signal: AbortSignal;
  tools?: OpenAITool[];
  onApproval?: (request: ApprovalRequest) => Promise<boolean>;
  onToolCall?: (call: ToolCall) => Promise<string>;
  onPhase?: (phase: ExecutionPhase) => void;
}

export interface CliRunner {
  readonly clientToolsReady?: boolean;
  readonly phasedTimeouts?: boolean;
  diagnose?(): Promise<{ available: boolean; code?: string }>;
  run(options: RunOptions): AsyncIterable<string>;
  listModels?(signal: AbortSignal): Promise<string[]>;
}

export interface OutputDecoder {
  beforeOutput?(): Promise<void>;
  readonly completed?: boolean;
  push(text: string): string[];
  finish(): string[];
}

export interface Command {
  managesStartup?: boolean;
  onSpawn?: (pid: number) => void;
  keepStdinOpen?: boolean;
  provider?: 'codex' | 'agy';
  executable: string;
  args: string[];
  input: string;
  decoder?: OutputDecoder;
  env?: NodeJS.ProcessEnv;
}

export async function waitForShutdown<T>(closed: Promise<T>, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProxyError('CLI process tree did not close before the shutdown deadline.', 504, 'cli_shutdown_timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}

export interface RunnerConfig {
  /** Trusted, server-side audit sink. MCP events contain correlation hashes, never credentials or arguments. */
  agyMcpObserver?: (event: Record<string, unknown>) => void;
  agyMcpRegistry?: AgyMcpWorkspaceRegistry;
  agyRegistry?: AgyWorkspaceRegistry;
  executable?: string;
  // Useful for native Node launchers and deterministic integration fixtures; no shell parsing.
  prefixArgs?: string[];
  cwd?: string;
  maxOutputBytes?: number;
}

export function killProcessTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // .kill() alone leaves language-server descendants alive on Windows.
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore', shell: false,
    });
    killer.on('error', () => { child.kill('SIGKILL'); });
    killer.on('exit', code => { if (code !== 0) child.kill('SIGKILL'); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  }
}

export abstract class SpawnRunner implements CliRunner {
  constructor(protected readonly config: RunnerConfig = {}) {}
  protected abstract command(options: RunOptions): Command;
  protected errorFromStderr(stderr: string): ProxyError | undefined { return authenticationError(stderr); }
  async diagnose(): Promise<{ available: boolean; code?: string }> {
    const command = this.command({ model: 'default', prompt: '', signal: new AbortController().signal });
    const executable = command.executable;
    return new Promise(resolve => {
      execFile(executable, [...(this.config.prefixArgs ?? []), '--help'], { cwd: SERVER_ROOT, env: cliEnvironment(command.provider), windowsHide: true, timeout: 3000, maxBuffer: 256 * 1024 }, error => {
        resolve(error ? { available: false, code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'cli_not_found' : 'cli_probe_failed' } : { available: true });
      });
    });
  }

  async *run(options: RunOptions): AsyncGenerator<string> {
    options.signal.throwIfAborted();
    if (options.context) validateExecution(options.context);
    const cwd = options.context?.workingDirectory ?? this.config.cwd;
    if (!cwd) throw new ProxyError('An explicit authorized workspace is required.', 403, 'workspace_not_authorized');
    const command = this.command(options);
    const child = spawn(options.context?.profile.executable ?? command.executable, [...(this.config.prefixArgs ?? []), ...command.args], {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...cliEnvironment(command.provider), ...command.env },
    });
    const outcome = new Promise<{ code: number | null; signal?: string; error?: Error }>(resolve => {
      child.once('error', error => resolve({ code: null, error }));
      child.once('close', (code, signal) => resolve({ code, ...(signal ? { signal } : {}) }));
    });
    child.once('spawn', () => {
      try { if (child.pid) command.onSpawn?.(child.pid); }
      catch (cause) {
        diagnosticError = cause instanceof ProxyError ? cause : new ProxyError('CLI process binding failed.', 502, 'cli_protocol_error');
        killProcessTree(child); child.stdout.destroy(diagnosticError);
      }
    });
    const abort = () => { killProcessTree(child); child.stdout.destroy(options.signal.reason instanceof Error ? options.signal.reason : new Error('CLI cancelled')); };
    const startup = command.managesStartup ? undefined : setTimeout(() => {
      diagnosticError = new ProxyError('CLI initialization timed out.', 504, 'cli_timeout');
      killProcessTree(child);
      child.stdout.destroy(diagnosticError);
    }, options.context?.profile.startupTimeoutMs ?? 30_000);
    startup?.unref();
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    let stderr = '';
    let diagnosticError: ProxyError | undefined;
    const stderrFilter = new AnsiFilter();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => {
      stderr = (stderr + stderrFilter.push(text)).slice(-16384);
      if (!diagnosticError) {
        diagnosticError = this.errorFromStderr(stderr);
        if (diagnosticError) { killProcessTree(child); child.stdout.destroy(diagnosticError); }
      }
    });
    // EPIPE is expected when authentication fails before the CLI consumes stdin.
    child.stdin.on('error', () => {});
    if (command.keepStdinOpen) child.stdin.write(command.input);
    else child.stdin.end(command.input);
    child.stdout.setEncoding('utf8');
    const stdoutFilter = new AnsiFilter();
    const responseFilter = new AnsiFilter();
    let outputBytes = 0;
    let stdoutTail = '';
    const checkSize = (text: string) => {
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > (options.context?.profile.maxOutputBytes ?? this.config.maxOutputBytes ?? 8 * 1024 * 1024)) {
        throw new ProxyError('CLI output exceeded the configured limit.', 502, 'output_limit');
      }
    };
    let finished = false;
    try {
      for await (const raw of child.stdout) {
        clearTimeout(startup);
        options.signal.throwIfAborted();
        const text = stdoutFilter.push(String(raw));
        stdoutTail = (stdoutTail + text).slice(-16384);
        checkSize(text);
        const parts = command.decoder?.push(text) ?? [text];
        await command.decoder?.beforeOutput?.();
        if (command.keepStdinOpen && command.decoder?.completed) child.stdin.end();
        for (const part of parts) {
          const clean = responseFilter.push(part);
          if (clean) yield clean;
        }
      }
      // A process can close stdout before exiting. Cancellation must still
      // reach finally and its bounded shutdown even if close never arrives.
      const result = await new Promise<Awaited<typeof outcome>>((resolve, reject) => {
        const interrupted = () => { options.signal.removeEventListener('abort', interrupted); reject(options.signal.reason ?? new Error('CLI cancelled')); };
        options.signal.addEventListener('abort', interrupted, { once: true });
        void outcome.then(value => { options.signal.removeEventListener('abort', interrupted); resolve(value); });
        if (options.signal.aborted) interrupted();
      });
      options.signal.throwIfAborted();
      if (diagnosticError) throw diagnosticError;
      const rejectedModel = modelError(`${stderr}\n${result.code !== 0 ? stdoutTail : ''}`);
      if (rejectedModel) throw rejectedModel;
      if (result.error) {
        const missing = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
        throw new ProxyError(`Cannot start ${command.executable}: ${result.error.message}`, missing ? 503 : 502, missing ? 'cli_not_found' : 'cli_error');
      }
      if (result.code !== 0) {
        throw new ProxyError(`CLI exited with ${result.signal ?? `code ${result.code}`}: ${stderr.trim().slice(-4000) || 'No diagnostic output.'}`);
      }
      for (const part of command.decoder?.finish() ?? []) {
        const clean = responseFilter.push(part);
        if (clean) yield clean;
      }
      finished = true;
    } catch (cause) {
      if (diagnosticError) throw diagnosticError;
      const rejectedModel = modelError(`${stderr}\n${stdoutTail}`);
      if (rejectedModel) throw rejectedModel;
      const reason: unknown = options.signal.reason;
      if (reason instanceof ProxyError && reason.code === 'cli_timeout' && stderr.trim()) {
        throw new ProxyError(`${reason.message}\nCLI diagnostics: ${stderr.trim().slice(-4000)}`, reason.statusCode, reason.code);
      }
      throw cause;
    } finally {
      clearTimeout(startup);
      options.signal.removeEventListener('abort', abort);
      if (!finished) {
        killProcessTree(child);
        await waitForShutdown(outcome, options.context?.profile.shutdownTimeoutMs ?? 5000);
      }
    }
  }
}
