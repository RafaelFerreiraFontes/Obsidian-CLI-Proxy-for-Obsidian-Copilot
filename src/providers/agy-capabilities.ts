import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { validateExecution } from '../config.js';
import type { RunOptions } from './base.js';
import type { AgyWorkspaceRegistry } from '../agy-workspaces.js';
import type { AgyMcpWorkspaceRegistry } from '../agy-mcp-workspaces.js';

/** Reviewed evidence, never an environment/HTTP switch or an operator assertion. */
export const AGY_REVIEWED_CLI = Object.freeze({ platform: 'win32', version: '1.4.10', sha256: 'fade3d94282b8c1b12a24e54ffa930183bd6f6ff7a73a90421fb0aab4d9402ba' });
export const AGY_PRODUCTION_BLOCKERS = Object.freeze(['all_actions_pretool_boundary_unverified', 'os_containment_unverified', 'native_mcp_session_isolation_unverified']);
export function agyCapabilitySummary() {
  return { status: 'blocked', external_execution: false, client_tools: false, reviewed_cli: AGY_REVIEWED_CLI, blockers: [...AGY_PRODUCTION_BLOCKERS], runtime_requirements: ['exclusive_authenticated_bridge', 'spawned_process_identity', 'native_conversation_id', 'hook_attestation', 'phase_deadlines', 'workspace_revalidation', 'worker_lease', 'process_ownership_and_birth', 'cancellation_and_cleanup'] };
}

/** Static preflight is necessary and deliberately insufficient to authorize spawn. */
export function inspectAgyCapability(options: RunOptions | undefined, executable: string, prefixArgs: string[] = [], registrations?: { hooks: AgyWorkspaceRegistry; mcp?: AgyMcpWorkspaceRegistry | undefined }) {
  const checks = { authorizedContext: false, authenticatedSession: false, supervisedProfile: false, hooksRegistration: false, mcpRegistration: false, nativeBinary: false, reviewedBinary: false };
  let binary: { path: string; sha256: string; device: number; inode: number } | undefined;
  if (options?.context) {
    try {
      validateExecution(options.context);
      const c = options.context, p = c.profile;
      checks.authorizedContext = !!c.identity && !!c.workspaceId && !!c.profileId && !!options.onApproval && c.workingDirectory === c.workspaceRoot;
      checks.authenticatedSession = /^(shared:|client:)/.test(c.identity) && typeof options.sessionId === 'string' && options.sessionId.length > 0;
      checks.supervisedProfile = p.provider === 'agy' && p.policy === 'supervised' && (p.models.includes('*') || p.models.includes(options.model));
      if (registrations) { registrations.hooks.verify(c); checks.hooksRegistration = true; }
      if (!options.tools?.length) checks.mcpRegistration = true;
      else if (registrations?.mcp) { registrations.mcp.verify(c); checks.mcpRegistration = true; }
    } catch { /* A failed check never becomes a capability. */ }
  }
  try {
    const candidates = isAbsolute(executable) ? [executable] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, executable));
    const path = candidates.find(candidate => { try { return lstatSync(candidate).isFile(); } catch { return false; } });
    if (path && !prefixArgs.length) {
      const canonical = realpathSync(path), stat = lstatSync(canonical);
      if (!stat.isSymbolicLink() && stat.isFile() && resolve(canonical) === canonical) {
        binary = { path: canonical, sha256: createHash('sha256').update(readFileSync(canonical)).digest('hex'), device: stat.dev, inode: stat.ino };
        checks.nativeBinary = true;
        checks.reviewedBinary = process.platform === AGY_REVIEWED_CLI.platform && binary.sha256 === AGY_REVIEWED_CLI.sha256;
      }
    }
  } catch { /* Do not expose executable diagnostics or permit a wrapper fallback. */ }
  return { ...agyCapabilitySummary(), checks, binary, eligible: false as const };
}
