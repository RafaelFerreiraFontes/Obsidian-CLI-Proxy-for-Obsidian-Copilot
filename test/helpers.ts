import { buildServer as build } from '../src/index.js';
import { readConfig, SERVER_ROOT } from '../src/config.js';
export const TEST_KEY = 'local-test-key-01234567890123456789';
export async function buildServer(options: Parameters<typeof build>[0] = {}) {
  const config = readConfig({ PROXY_API_KEY: TEST_KEY, PROXY_WORKSPACES: JSON.stringify({ proxy: SERVER_ROOT }), PROXY_DEFAULT_WORKSPACE: 'proxy' });
  if (options.timeoutMs !== undefined) for (const profile of Object.values(config.profiles)) profile.timeoutMs = options.timeoutMs;
  const app = await build({ ...options, config: options.config ?? config });
  const inject = app.inject.bind(app);
  app.inject = ((input: any, callback?: any) => {
    const opts = typeof input === 'string' ? { url: input } : input;
    return inject({ ...opts, headers: { authorization: `Bearer ${TEST_KEY}`, ...opts.headers } }, callback);
  }) as typeof app.inject;
  return app;
}
