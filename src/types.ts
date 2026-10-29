export type MessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAITool {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface ChatMessage {
  role: MessageRole;
  content?: string | Array<{ type: 'text'; text: string }> | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  stream_options?: { include_usage?: boolean };
  tools?: OpenAITool[];
  user?: string;
  conversation_id?: string;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: 'assistant'; content?: string; tool_calls?: Array<ToolCall & { index: number }> };
    finish_reason: 'stop' | 'tool_calls' | null;
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
  const type = code === 'authentication_error' ? 'authentication_error' : code === 'rate_limit' ? 'rate_limit_error'
    : /not_authorized$/.test(code) ? 'permission_error'
    : ['invalid_request_error', 'model_not_found', 'workspace_not_found', 'tool_not_supported', 'session_conflict'].includes(code) ? 'invalid_request_error' : 'server_error';
  return { error: { message: error.message, type, param: ['model_not_found', 'model_not_authorized'].includes(code) ? 'model' : null, code } };
}
