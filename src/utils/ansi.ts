// Stateful filtering handles escape sequences split across arbitrary stdout chunks.
export class AnsiFilter {
  private state: 'text' | 'escape' | 'csi' | 'osc' | 'oscEscape' = 'text';

  push(input: string): string {
    let output = '';
    for (const char of input) {
      if (this.state === 'text') {
        if (char === '\x1b') this.state = 'escape';
        else if (char === '\x9b') this.state = 'csi';
        else if (char === '\x9d') this.state = 'osc';
        else output += char;
      } else if (this.state === 'escape') {
        this.state = char === '[' ? 'csi' : char === ']' ? 'osc' : 'text';
      } else if (this.state === 'csi') {
        if (char >= '@' && char <= '~') this.state = 'text';
      } else if (this.state === 'osc') {
        if (char === '\x07' || char === '\x9c') this.state = 'text';
        else if (char === '\x1b') this.state = 'oscEscape';
      } else {
        this.state = char === '\\' ? 'text' : 'osc';
      }
    }
    return output;
  }
}
