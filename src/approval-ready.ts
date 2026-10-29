// SessionStart/PreInvocation attestation only. It never grants a tool permission.
try {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk.toString(); if (Buffer.byteLength(input) > 1024 * 1024) throw new Error(); }
  let token = process.env.CLI_PROXY_HOOK_TOKEN;
  let address = process.env.CLI_PROXY_HOOK_URL;
  if (process.env.CLI_PROXY_REQUIRE_LEASE === '1' || (!token && !address)) {
    const credentials = await (await import('./hook-credentials.js')).readHookCredentials(JSON.parse(input));
    token = credentials.token; address = credentials.url;
  }
  const url = new URL(address ?? '');
  if (!token || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/approve' || url.username || url.password || url.search || url.hash) throw new Error();
  url.pathname = '/ready';
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: input, signal: AbortSignal.timeout(5000), redirect: 'error' });
  const result = await response.json() as { ready?: boolean };
  if (!response.ok || result.ready !== true) throw new Error();
  console.log('{}');
} catch {
  console.log('{}');
  process.exitCode = 1;
}
export {};
