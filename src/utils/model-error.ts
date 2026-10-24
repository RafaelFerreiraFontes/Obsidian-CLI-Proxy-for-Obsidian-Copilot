import { ProxyError } from '../types.js';

export function modelError(message: string): ProxyError | undefined {
  const failure = /(?:unknown|invalid|unsupported|unrecognized|nonexistent|non-existent)\s+(?:\S+\s+){0,2}model|model[^\n]{0,180}(?:not found|does not exist|doesn't exist|not supported|unsupported|not available|unrecognized|not recognized|not permitted|not have access)/i;
  return failure.test(message)
    ? new ProxyError(`The CLI rejected the requested model: ${message.trim().slice(-2000)}`, 404, 'model_not_found')
    : undefined;
}
