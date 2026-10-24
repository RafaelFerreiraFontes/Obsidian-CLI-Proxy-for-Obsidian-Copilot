import type { CliRunner } from './providers/base.js';
import { AnsiFilter } from './utils/ansi.js';

export const CODEX_MODELS = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
export const AGY_FALLBACK_MODELS = [
  'gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low',
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high',
  'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high', 'gpt-oss-120b-medium',
];

export function parseAgyModels(stdout: string): string[] {
  return [...new Set(new AnsiFilter().push(stdout).split(/\r?\n/).flatMap(line => {
    const match = /^\s*([a-z0-9][a-z0-9._-]*)\s+\S.*$/.exec(line);
    const id = match?.[1];
    return id && !['model', 'model-id', 'id', 'error', 'warning', 'fetching', 'available', 'models', 'loading'].includes(id) ? [id] : [];
  }))];
}

export function canonicalModel(model: string): string {
  const [provider, ...rest] = model.split('/');
  const id = rest.join('/');
  return provider === 'codex' && CODEX_MODELS.includes(id.toLowerCase()) ? `codex/${id.toLowerCase()}` : model;
}

export class ModelCatalog {
  private cached: string[] | undefined;
  private expires = 0;
  private inflight: Promise<string[]> | undefined;
  private controller: AbortController | undefined;

  constructor(private runner: CliRunner, private extras: string[] = [], private ttlMs = 60_000) {}

  async list(): Promise<string[]> {
    if (this.cached && Date.now() < this.expires) return this.cached;
    if (this.inflight) return this.inflight;
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(5000)]);
    this.inflight = (async () => {
      let agy = AGY_FALLBACK_MODELS;
      try {
        const found = await this.runner.listModels?.(signal);
        if (found?.length) agy = found;
      } catch { /* Offline, missing CLI, expired login, timeout: advertise the fallback list. */ }
      this.cached = [...new Set(['codex/default', ...CODEX_MODELS.map(id => `codex/${id}`), 'agy/default', ...agy.map(id => `agy/${id}`), ...this.extras])]
        .filter(id => /^(codex|agy)\/\S+$/.test(id));
      this.expires = Date.now() + this.ttlMs;
      return this.cached;
    })().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  close(): void { this.controller?.abort(); }
}
