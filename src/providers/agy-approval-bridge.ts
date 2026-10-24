import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { RunOptions } from './base.js';

export async function createAgyApprovalBridge(options: RunOptions) {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/approve' || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end(); return;
    }
    try {
      let text = '';
      for await (const chunk of request) {
        text += chunk.toString();
        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Hook input too large');
      }
      const input = JSON.parse(text);
      if (!input.toolCall || typeof input.toolCall.name !== 'string' || !input.toolCall.args || typeof input.toolCall.args !== 'object') throw new Error('Invalid hook payload');
      const args = input.toolCall.args;
      const approved = await options.onApproval!({
        action: `${input.toolCall.name}\n${JSON.stringify(args, null, 2)}`,
        cwd: typeof args.Cwd === 'string' ? args.Cwd : input.workspacePaths?.[0] ?? process.cwd(),
        reason: typeof args.Justification === 'string' ? args.Justification : 'Antigravity PreToolUse: action has not executed.',
      });
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ approved }));
    } catch {
      if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end('{"approved":false}');
    }
  });
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot start approval bridge');
  return {
    env: { CLI_PROXY_HOOK_URL: `http://127.0.0.1:${address.port}/approve`, CLI_PROXY_HOOK_TOKEN: token },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
