import { loadEnvFile } from 'node:process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ProxyError } from './types.js';

// Walk from this module, never from the caller's cwd (also works in compiled tests).
let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(root, 'package.json'))) {
  const parent = dirname(root);
  if (parent === root) throw new Error('Cannot locate server package.json.');
  root = parent;
}
export const SERVER_ROOT = realpathSync(root);
export const HOOK_ROOT = join(SERVER_ROOT, '.agents');
export function loadServerEnv(): void {
  try { loadEnvFile(join(SERVER_ROOT, '.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot load server .env.'); }
}

export type Policy = 'read-only' | 'supervised' | 'write-enabled';
export interface Profile {
  executable?: string;
  provider: 'codex' | 'agy'; policy: Policy; models: string[]; tools: 'client' | 'none';
  timeoutMs: number; startupTimeoutMs: number; maxOutputBytes: number;
  spawnTimeoutMs?: number; initTimeoutMs?: number; attestationTimeoutMs?: number;
  shutdownTimeoutMs?: number; approvalTimeoutMs?: number; toolTimeoutMs?: number;
}
export interface Client { key: string; workspaces: string[]; profiles: string[] }
export interface Config {
  host: string; port: number; apiKey: string; allowRemote: boolean; origins: string[];
  workspaces: Record<string, string>; defaultWorkspace: string;
  profiles: Record<string, Profile>; clients: Record<string, Client>;
  maxSessions: number; maxRequestsPerMinute: number; approvalTimeoutMs: number;
  workspacePins: Record<string, { canonical: string; device: number; inode: number } | null>;
  diagnostics: boolean;
}
export function positiveInteger(input: string | undefined, fallback: number, name: string): number {
  const value = input === undefined ? fallback : Number(input);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}
export function boundedTimeout(input: string | undefined, fallback: number, maximum: number, name: string): number {
  const value = positiveInteger(input, fallback, name);
  if (value > maximum) throw new Error(`${name} must be at most ${maximum}.`);
  return value;
}
function json<T>(env: NodeJS.ProcessEnv, name: string, fallback: T): T {
  try {
    const value: unknown = env[name] === undefined ? fallback : JSON.parse(env[name]!);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as T;
  } catch { throw new Error(`${name} must be a JSON object (values omitted).`); }
}
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const timeoutMs = positiveInteger(env.CLI_TIMEOUT_MS, 120_000, 'CLI_TIMEOUT_MS');
  const startupTimeoutMs = positiveInteger(env.CLI_STARTUP_TIMEOUT_MS, 30_000, 'CLI_STARTUP_TIMEOUT_MS');
  const maxOutputBytes = positiveInteger(env.CLI_MAX_OUTPUT_BYTES, 8 * 1024 * 1024, 'CLI_MAX_OUTPUT_BYTES');
  const workspaces = json<Record<string, string>>(env, 'PROXY_WORKSPACES', {});
  const workspacePins: Config['workspacePins'] = {};
  for (const [id, path] of Object.entries(workspaces)) {
    if (!idPattern.test(id) || typeof path !== 'string' || !isAbsolute(path)) throw new Error('PROXY_WORKSPACES requires safe IDs and absolute directories.');
    try {
      const canonical = realpathSync(path);
      const stat = statSync(canonical);
      workspacePins[id] = stat.isDirectory() ? { canonical, device: stat.dev, inode: stat.ino } : null;
    } catch { workspacePins[id] = null; }
  }
  const profiles = json<Record<string, Profile>>(env, 'PROXY_PROFILES', {
    codex: { provider: 'codex', policy: 'read-only', models: ['*'], tools: 'client', timeoutMs, startupTimeoutMs, maxOutputBytes },
    agy: { provider: 'agy', policy: 'supervised', models: ['*'], tools: 'none', timeoutMs, startupTimeoutMs, maxOutputBytes },
  });
  for (const [id, profile] of Object.entries(profiles)) {
    if (!idPattern.test(id) || !profile || !['codex', 'agy'].includes(profile.provider) || !['read-only', 'supervised', 'write-enabled'].includes(profile.policy)
      || !['client', 'none'].includes(profile.tools) || !Array.isArray(profile.models) || !profile.models.length || !profile.models.every(model => typeof model === 'string' && model.length > 0)) throw new Error('Invalid PROXY_PROFILES entry.');
    profile.timeoutMs = boundedTimeout(profile.timeoutMs?.toString(), timeoutMs, 3_600_000, 'profile.timeoutMs');
    profile.startupTimeoutMs = positiveInteger(profile.startupTimeoutMs?.toString(), startupTimeoutMs, 'profile.startupTimeoutMs');
    profile.maxOutputBytes = positiveInteger(profile.maxOutputBytes?.toString(), maxOutputBytes, 'profile.maxOutputBytes');
    profile.spawnTimeoutMs = boundedTimeout(profile.spawnTimeoutMs?.toString() ?? env.CLI_SPAWN_TIMEOUT_MS, 10_000, 60_000, 'profile.spawnTimeoutMs');
    profile.initTimeoutMs = boundedTimeout(profile.initTimeoutMs?.toString() ?? env.AGY_INIT_TIMEOUT_MS, 30_000, 180_000, 'profile.initTimeoutMs');
    profile.attestationTimeoutMs = boundedTimeout(profile.attestationTimeoutMs?.toString() ?? env.AGY_ATTESTATION_TIMEOUT_MS, 180_000, 600_000, 'profile.attestationTimeoutMs');
    profile.shutdownTimeoutMs = boundedTimeout(profile.shutdownTimeoutMs?.toString() ?? env.CLI_SHUTDOWN_TIMEOUT_MS, 5_000, 30_000, 'profile.shutdownTimeoutMs');
    profile.approvalTimeoutMs = boundedTimeout(profile.approvalTimeoutMs?.toString() ?? env.APPROVAL_TIMEOUT_MS, 300_000, 580_000, 'profile.approvalTimeoutMs');
    profile.toolTimeoutMs = boundedTimeout(profile.toolTimeoutMs?.toString() ?? env.TOOL_TIMEOUT_MS, 300_000, 580_000, 'profile.toolTimeoutMs');
    if (profile.executable !== undefined && (typeof profile.executable !== 'string' || !profile.executable || /[\r\n\0]/.test(profile.executable))) throw new Error('Profile executable must be a single executable path, without arguments.');
    if (profile.provider === 'agy' && (profile.policy !== 'supervised' || profile.tools !== 'none')) throw new Error('Antigravity supports only supervised policy and tools:none in this adapter.');
  }
  const clients = json<Record<string, Client>>(env, 'PROXY_CLIENTS', {});
  for (const [id, client] of Object.entries(clients)) {
    if (!idPattern.test(id) || !client || typeof client.key !== 'string' || client.key.length < 24 || !Array.isArray(client.workspaces) || !Array.isArray(client.profiles)
      || !client.workspaces.every(id => Object.hasOwn(workspaces, id)) || !client.profiles.every(id => Object.hasOwn(profiles, id))) throw new Error('Invalid PROXY_CLIENTS entry (key must have at least 24 characters).');
  }
  const apiKey = env.PROXY_API_KEY ?? '';
  if (apiKey && apiKey.length < 24) throw new Error('PROXY_API_KEY must have at least 24 characters.');
  const keys = [apiKey, ...Object.values(clients).map(c => c.key)].filter(Boolean);
  if (new Set(keys).size !== keys.length) throw new Error('Client keys must be unique.');
  const host = env.HOST ?? '127.0.0.1';
  if (env.ALLOW_REMOTE !== undefined && !['true', 'false'].includes(env.ALLOW_REMOTE)) throw new Error('ALLOW_REMOTE must be true or false.');
  const allowRemote = env.ALLOW_REMOTE === 'true';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && (!allowRemote || !keys.length)) throw new Error('External HOST requires ALLOW_REMOTE=true and API authentication.');
  const port = positiveInteger(env.PORT, 3000, 'PORT');
  if (port > 65535) throw new Error('PORT must be at most 65535.');
  const defaultWorkspace = env.PROXY_DEFAULT_WORKSPACE ?? '';
  if (defaultWorkspace && !Object.hasOwn(workspaces, defaultWorkspace)) throw new Error('PROXY_DEFAULT_WORKSPACE must name a configured workspace.');
  const origins = (env.CORS_ORIGINS ?? 'app://obsidian.md').split(',').map(s => s.trim()).filter(Boolean);
  if (origins.includes('*')) throw new Error('CORS_ORIGINS must list explicit origins.');
  const approvalTimeoutMs = positiveInteger(env.APPROVAL_TIMEOUT_MS, 300_000, 'APPROVAL_TIMEOUT_MS');
  if (approvalTimeoutMs > 580_000) throw new Error('APPROVAL_TIMEOUT_MS must be at most 580000 (hook deadline).');
  if (env.DIAGNOSTICS !== undefined && !['true', 'false'].includes(env.DIAGNOSTICS)) throw new Error('DIAGNOSTICS must be true or false.');
  return { host, port, allowRemote, apiKey, clients, origins, workspaces, workspacePins, defaultWorkspace, profiles, diagnostics: env.DIAGNOSTICS === 'true',
    maxSessions: positiveInteger(env.MAX_SESSIONS, 32, 'MAX_SESSIONS'),
    maxRequestsPerMinute: positiveInteger(env.MAX_REQUESTS_PER_MINUTE, 120, 'MAX_REQUESTS_PER_MINUTE'),
    approvalTimeoutMs };
}
export function secureEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}
export function authenticate(config: Config, authorization: string): { identity: string; client: Client } {
  let match: { identity: string; client: Client } | undefined;
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (secureEqual(token, config.apiKey) && config.apiKey) match = { identity: 'shared:local', client: { key: config.apiKey, workspaces: Object.keys(config.workspaces), profiles: Object.keys(config.profiles) } };
  for (const [identity, client] of Object.entries(config.clients)) if (secureEqual(token, client.key)) match = { identity: `client:${identity}`, client };
  if (!match) throw new ProxyError('A valid local Bearer API key is required.', 401, 'authentication_error');
  return match;
}

export interface ExecutionContext {
  identity: string; workspaceId: string; workspaceRoot: string; workingDirectory: string;
  configuredPath: string; device: number; inode: number; profileId: string; profile: Profile;
}
export function executionContext(config: Config, auth: ReturnType<typeof authenticate>, workspaceId: string, profileId: string, model: string): ExecutionContext {
  if (!auth.client.workspaces.includes(workspaceId) || !Object.hasOwn(config.workspaces, workspaceId)) throw new ProxyError('Workspace ID is not authorized.', 403, 'workspace_not_authorized');
  if (!auth.client.profiles.includes(profileId) || !Object.hasOwn(config.profiles, profileId)) throw new ProxyError('Profile is not authorized.', 403, 'profile_not_authorized');
  const profile = config.profiles[profileId]!;
  if (!model.startsWith(`${profile.provider}/`) || (!profile.models.includes('*') && !profile.models.includes(model.slice(model.indexOf('/') + 1)))) throw new ProxyError('Model is not permitted by this profile.', 403, 'model_not_authorized');
  const configuredPath = config.workspaces[workspaceId]!;
  const pin = config.workspacePins[workspaceId];
  if (!pin) throw new ProxyError('Authorized workspace directory was unavailable at startup. Restart after fixing it.', 404, 'workspace_not_found');
  try {
    const workspaceRoot = realpathSync(configuredPath);
    const stat = statSync(workspaceRoot);
    if (!stat.isDirectory()) throw new Error();
    if (workspaceRoot !== pin.canonical || stat.dev !== pin.device || stat.ino !== pin.inode) throw new ProxyError('Workspace changed since startup.', 409, 'session_conflict');
    return { identity: auth.identity, workspaceId, workspaceRoot, workingDirectory: workspaceRoot, configuredPath, device: stat.dev, inode: stat.ino, profileId, profile };
  } catch (error) { if (error instanceof ProxyError) throw error; throw new ProxyError('Authorized workspace directory is unavailable.', 404, 'workspace_not_found'); }
}
export function validateExecution(context: ExecutionContext): void {
  try {
    const path = realpathSync(context.configuredPath);
    const stat = statSync(path);
    if (path !== context.workspaceRoot || stat.dev !== context.device || stat.ino !== context.inode || !stat.isDirectory()) throw new Error();
  } catch { throw new ProxyError('Workspace changed or is no longer available.', 409, 'session_conflict'); }
}
// Credential homes are needed by installed CLIs; server API keys and NODE_OPTIONS are never inherited.
export function cliEnvironment(provider?: 'codex' | 'agy'): NodeJS.ProcessEnv {
  const names = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']);
  for (const name of provider === 'codex' ? ['CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY'] : provider === 'agy' ? ['GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'] : []) names.add(name);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toUpperCase()))), NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' };
}
