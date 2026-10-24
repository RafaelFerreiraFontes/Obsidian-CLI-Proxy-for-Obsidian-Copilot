export type MessageRole = 'system' | 'developer' | 'user' | 'assistant';

export interface ChatMessage {
  role: MessageRole;
  content: string | Array<{ type: 'text'; text: string }>;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  stream_options?: { include_usage?: boolean };
  tools?: unknown[];
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: 'assistant'; content?: string };
    finish_reason: 'stop' | null;
  }>;
}

export interface Model {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export class ProxyError extends Error {
  constructor(message: string, public statusCode = 502, public code = 'cli_error') {
    super(message);
    this.name = 'ProxyError';
  }
}

export function errorBody(error: Error, code = 'cli_error') {
  return { error: { message: error.message, type: code === 'invalid_request_error' ? code : 'server_error', param: null, code } };
}
