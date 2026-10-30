import { randomUUID } from 'node:crypto';
import type { ProcessWitness } from '../src/providers/agy-process-witness.js';

export const fixtureProcessWitness: ProcessWitness = async () => async () => {};

/** Test protocol peer. process.pid here is a fixture claim, not OS attestation. */
export function mcpPeer(env: { CLI_PROXY_MCP_URL: string; CLI_PROXY_MCP_TOKEN: string; CLI_PROXY_MCP_SESSION: string }, workspace: string, conversation?: string) {
  const peerId = randomUUID(); let lease: Promise<string> | undefined;
  const send = (path: string, body: Record<string, unknown>, token = env.CLI_PROXY_MCP_TOKEN, signal?: AbortSignal) => fetch(new URL(path, env.CLI_PROXY_MCP_URL), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: env.CLI_PROXY_MCP_SESSION, workspace, peerId, ...body }), ...(signal ? { signal } : {}) });
  const attach = () => lease ??= send('attach', { workerPid: process.pid }).then(async response => { if (!response.ok) throw Error('Fixture MCP attach failed'); return (await response.json() as { lease: string }).lease; });
  return {
    peerId, attach, send,
    async post(path: string, body: Record<string, unknown> = {}, token = env.CLI_PROXY_MCP_TOKEN, signal?: AbortSignal) { const peerLease = await attach(); return send(path, { peerLease, rpcId: randomUUID(), nativeConversationId: conversation, nativeRootConversationId: conversation, ...body }, token, signal); },
  };
}
