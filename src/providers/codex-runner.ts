import { SpawnRunner, type Command, type RunOptions } from './base.js';

export class CodexRunner extends SpawnRunner {
  protected command(options: RunOptions): Command {
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
      '--sandbox', 'read-only', '-c', 'approval_policy="never"'];
    if (options.model !== 'default') args.push('--model', options.model);
    args.push('-');
    return {
      executable: this.config.executable ?? process.env.CODEX_BIN ?? 'codex',
      args,
      input: options.prompt,
    };
  }
}
