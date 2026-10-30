import { ProxyError } from '../types.js';
import type { Profile } from '../config.js';

export type ExecutionPhase = 'spawning' | 'initializing' | 'attesting' | 'active' | 'waiting_approval' | 'waiting_tool';

/** Phase deadlines are independent. Pending human/tool time never consumes inference time. */
export class AgyLifecycle {
  private timer: NodeJS.Timeout | undefined;
  private initialized = false;
  private attested = false;
  private closed = false;
  constructor(private profile: Partial<Profile>, private fail: (error: ProxyError) => void, private notify: (phase: ExecutionPhase) => void = () => {}) {}
  phase(phase: ExecutionPhase): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    const deadlines: Record<ExecutionPhase, [number, string, string]> = {
      spawning: [this.profile.spawnTimeoutMs ?? 10_000, 'cli_spawn_timeout', 'Antigravity process spawn timed out.'],
      initializing: [this.profile.initTimeoutMs ?? 30_000, 'cli_init_timeout', 'Antigravity did not emit a valid init event.'],
      attesting: [this.profile.attestationTimeoutMs ?? 180_000, 'approval_attestation_timeout', 'Antigravity hook attestation timed out.'],
      active: [this.profile.timeoutMs ?? 120_000, 'cli_timeout', 'Antigravity active execution timed out.'],
      waiting_approval: [this.profile.approvalTimeoutMs ?? 300_000, 'approval_timeout', 'Human approval expired; action was not authorized.'],
      waiting_tool: [this.profile.toolTimeoutMs ?? 300_000, 'tool_timeout', 'Client tool result timed out.'],
    };
    const [ms, code, message] = deadlines[phase];
    this.notify(phase);
    this.timer = setTimeout(() => this.fail(new ProxyError(message, 504, code)), ms);
    this.timer.unref();
  }
  spawned(): void { this.phase('initializing'); }
  init(): void { this.initialized = true; this.phase(this.attested ? 'active' : 'attesting'); }
  ready(): void { this.attested = true; if (this.initialized) this.phase('active'); }
  close(): void { this.closed = true; clearTimeout(this.timer); }
}
