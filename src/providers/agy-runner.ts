import { ProxyError } from '../types.js';
import { SpawnRunner, type Command, type OutputDecoder, type RunOptions } from './base.js';

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
        throw new ProxyError(`Antigravity failed (${result?.status ?? 'unknown'}): ${typeof result?.error === 'string' ? result.error : JSON.stringify(result?.error ?? 'No diagnostic output.')}`);
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
  protected override errorFromStderr(stderr: string): ProxyError | undefined {
    if (/Authentication required|silent auth failed|Please sign in to view available models/i.test(stderr)) {
      return new ProxyError('Antigravity authentication is unavailable. Run agy interactively in your terminal to sign in, then restart the proxy with the same OS account and credential environment.', 502, 'cli_authentication_error');
    }
    return undefined;
  }

  protected command(options: RunOptions): Command {
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands'];
    if (options.model !== 'default') args.push('--model', options.model);
    return {
      executable: this.config.executable ?? process.env.AGY_BIN ?? (process.platform === 'win32' ? 'agy.exe' : 'agy'),
      args,
      input: JSON.stringify({ event: 'user', message: { content: options.prompt } }) + '\n',
      decoder: new AgyDecoder(),
    };
  }
}
