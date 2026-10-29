import { ProxyError } from '../types.js';
export function authenticationError(text: string): ProxyError | undefined {
  return /authentication (?:required|expired|failed)|silent auth failed|login required|unauthorized|invalid api key|please sign in/i.test(text)
    ? new ProxyError('CLI authentication is unavailable or expired. Verify the existing CLI login in your terminal.', 502, 'cli_authentication_error') : undefined;
}
