import { SpawnRunner, type Command, type RunOptions } from './base.js';
import { runCodexAppServer } from './codex-app-server.js';

export class CodexRunner extends SpawnRunner {
  override async *run(options: RunOptions): AsyncGenerator<string> {
    if (options.onApproval) yield* runCodexAppServer(options, this.config);
    else yield* super.run(options);
  }

  protected command(options: RunOptions): Command {
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
      '--sandbox', 'read-only', '-c', 'approval_policy="never"'];
    if (options.model !== 'default') args.push('--model', options.model);
    args.push('-');
    return {
      provider: 'codex',
      executable: this.config.executable ?? process.env.CODEX_BIN ?? 'codex',
      args,
      input: options.prompt,
    };
  }
}
