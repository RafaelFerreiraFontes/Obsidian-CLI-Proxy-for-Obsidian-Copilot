// Antigravity PreToolUse: missing/unreachable bridge always denies execution.
async function main() {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Hook input too large');
    }
    const payload = JSON.parse(input);
    if (!payload || typeof payload !== 'object' || !payload.toolCall || typeof payload.toolCall.name !== 'string' || !payload.toolCall.args || typeof payload.toolCall.args !== 'object' || Array.isArray(payload.toolCall.args)) throw new Error('Invalid hook payload');
    let url = process.env.CLI_PROXY_HOOK_URL;
    let token = process.env.CLI_PROXY_HOOK_TOKEN;
    if (process.env.CLI_PROXY_REQUIRE_LEASE === '1' || (!url && !token)) {
      if (!('conversationId' in payload)) throw new Error('Approval bridge unavailable');
      const credentials = await (await import('./hook-credentials.js')).readHookCredentials(payload);
      url = credentials.url; token = credentials.token;
    }
    if (!url || !token) throw new Error('Approval bridge unavailable');
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/approve' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid bridge URL');
    const timeout = Number(process.env.CLI_PROXY_APPROVAL_TIMEOUT_MS ?? 300_000);
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 580_000) throw new Error('Invalid timeout');
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: input, signal: AbortSignal.timeout(timeout + 5000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Approval bridge unavailable');
    const result = await response.json() as { approved?: boolean };
    console.log(JSON.stringify({ decision: result.approved === true ? 'auto_approve' : 'deny', reason: result.approved === true ? 'User approved this action in Obsidian Copilot.' : 'User denied this action or approval expired.' }));
  } catch {
    console.log(JSON.stringify({ decision: 'deny', reason: 'Approval bridge unavailable; action was not authorized.' }));
  }
}
void main();
