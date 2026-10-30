import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { SERVER_ROOT, validateExecution, type ExecutionContext } from './config.js';
import { ProxyError } from './types.js';

const DIRECTORY = join(SERVER_ROOT, '.local', 'agy-runtime');
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
const fileName = (id: string) => `${createHash('sha256').update(id).digest('hex')}.json`;
export interface HookCredentials { url: string; token: string; approvalTimeoutMs?: number }
function validApprovalTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 580_000;
}

/** Native init.conversation_id only; never a prompt, header, or client-supplied path. */
export class HookCredentialLease {
  private path: string | undefined;
  private conversation: string | undefined;
  constructor(private context: ExecutionContext, private credentials: HookCredentials, private directory = DIRECTORY) {}
  async register(id: unknown, cwd: unknown): Promise<void> {
    if (this.credentials.approvalTimeoutMs !== undefined && !validApprovalTimeout(this.credentials.approvalTimeoutMs)) throw new Error('Invalid approval timeout');
    if (!validId(id) || typeof cwd !== 'string' || realpathSync(cwd) !== this.context.workspaceRoot) throw new ProxyError('Antigravity init does not match the authorized workspace.', 502, 'cli_protocol_error');
    if (this.conversation) {
      if (this.conversation !== id) throw new ProxyError('Antigravity changed its conversation ID.', 502, 'cli_protocol_error');
      return;
    }
    validateExecution(this.context);
    const inside = relative(this.context.workspaceRoot, this.directory);
    if (inside === '' || (!inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && inside !== '..' && !isAbsolute(inside))) throw new ProxyError('Hook runtime credentials must be outside the agent workspace.', 503, 'approval_hook_failed');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink() || realpathSync(this.directory) !== this.directory) throw new ProxyError('Hook runtime directory is not canonical.', 503, 'approval_hook_failed');
    const path = join(this.directory, fileName(id));
    await writeFile(path, JSON.stringify({ version: 1, conversation: id, workspace: this.context.workspaceRoot, ...this.credentials }), { flag: 'wx', mode: 0o600 });
    this.conversation = id; this.path = path;
  }
  async close(): Promise<void> { if (this.path) { await unlink(this.path); this.path = undefined; } }
}

/** Called only from the installed handler. Nothing is read from the workspace. */
export async function readHookCredentials(input: unknown, directory = DIRECTORY): Promise<HookCredentials> {
  if (!input || typeof input !== 'object' || !('conversationId' in input) || !validId(input.conversationId) || !('workspacePaths' in input) || !Array.isArray(input.workspacePaths) || input.workspacePaths.length !== 1) throw new Error('Invalid native hook context');
  const path = join(directory, fileName(input.conversationId));
  // SessionStart can race init's delivery. Wait briefly; absence always denies.
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('Invalid runtime directory');
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid runtime resource');
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (value.version !== 1 || value.conversation !== input.conversationId || typeof value.workspace !== 'string' || realpathSync(input.workspacePaths[0]) !== value.workspace || typeof value.url !== 'string' || typeof value.token !== 'string') throw new Error('Invalid runtime context');
      if (value.approvalTimeoutMs !== undefined && !validApprovalTimeout(value.approvalTimeoutMs)) throw new Error('Invalid approval timeout');
      return { url: value.url, token: value.token, ...(value.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: value.approvalTimeoutMs as number }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error('Runtime credentials unavailable');
}
