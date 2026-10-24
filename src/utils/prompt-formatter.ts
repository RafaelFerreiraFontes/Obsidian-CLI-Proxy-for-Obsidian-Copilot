import type { ChatMessage } from '../types.js';

export function formatPrompt(messages: ChatMessage[]): string {
  // JSON preserves exact text and role boundaries, including delimiter-like user text.
  return [
    'Continue the following conversation as the assistant. Follow the system and developer',
    'instructions in the transcript. Reply only with the assistant response, without role labels.',
    'Use tools when needed for the user request. Request execution permission through the CLI approval mechanism.',
    'Conversation (JSON):',
    JSON.stringify(messages.map(message => ({
      role: message.role,
      content: typeof message.content === 'string'
        ? message.content
        : message.content?.map(part => part.text).join('') ?? '',
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    }))),
  ].join('\n');
}
