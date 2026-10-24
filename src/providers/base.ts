import { spawn, type ChildProcess } from 'node:child_process';
import { ProxyError } from '../types.js';
import { AnsiFilter } from '../utils/ansi.js';

export interface RunOptions {
  model: string;
  prompt: string;
  signal: AbortSignal;
}

export interface CliRunner {
  run(options: RunOptions): AsyncIterable<string>;
}

export interface OutputDecoder {
  push(text: string): string[];
  finish(): string[];
}

export interface Command {
  executable: string;
  args: string[];
  input: string;
  decoder?: OutputDecoder;
}

export interface RunnerConfig {
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
  protected errorFromStderr(_stderr: string): ProxyError | undefined { return undefined; }

  async *run(options: RunOptions): AsyncGenerator<string> {
    options.signal.throwIfAborted();
    const command = this.command(options);
    const child = spawn(command.executable, [...(this.config.prefixArgs ?? []), ...command.args], {
      cwd: this.config.cwd ?? process.cwd(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
    });
    const outcome = new Promise<{ code: number | null; signal?: string; error?: Error }>(resolve => {
      child.once('error', error => resolve({ code: null, error }));
      child.once('close', (code, signal) => resolve({ code, ...(signal ? { signal } : {}) }));
    });
    const abort = () => killProcessTree(child);
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
        if (diagnosticError) killProcessTree(child);
      }
    });
    // EPIPE is expected when authentication fails before the CLI consumes stdin.
    child.stdin.on('error', () => {});
    child.stdin.end(command.input);
    child.stdout.setEncoding('utf8');
    const stdoutFilter = new AnsiFilter();
    const responseFilter = new AnsiFilter();
    let outputBytes = 0;
    const checkSize = (text: string) => {
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > (this.config.maxOutputBytes ?? 8 * 1024 * 1024)) {
        throw new ProxyError('CLI output exceeded the configured limit.', 502, 'output_limit');
      }
    };
    let finished = false;
    try {
      for await (const raw of child.stdout) {
        options.signal.throwIfAborted();
        const text = stdoutFilter.push(String(raw));
        checkSize(text);
        for (const part of command.decoder?.push(text) ?? [text]) {
          const clean = responseFilter.push(part);
          if (clean) yield clean;
        }
      }
      const result = await outcome;
      options.signal.throwIfAborted();
      if (diagnosticError) throw diagnosticError;
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
      const reason: unknown = options.signal.reason;
      if (reason instanceof ProxyError && reason.code === 'cli_timeout' && stderr.trim()) {
        throw new ProxyError(`${reason.message}\nCLI diagnostics: ${stderr.trim().slice(-4000)}`, reason.statusCode, reason.code);
      }
      throw cause;
    } finally {
      options.signal.removeEventListener('abort', abort);
      if (!finished) {
        killProcessTree(child);
        await outcome;
      }
    }
  }
}
