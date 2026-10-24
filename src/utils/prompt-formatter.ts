import type { ChatMessage } from '../types.js';

export function formatPrompt(messages: ChatMessage[]): string {
  // JSON preserves exact text and role boundaries, including delimiter-like user text.
  return [
    'Continue the following conversation as the assistant. Follow the system and developer',
    'instructions in the transcript. Reply only with the assistant response, without role labels.',
    'This is a chat request; do not inspect or modify local files or execute tools.',
    'Conversation (JSON):',
    JSON.stringify(messages.map(message => ({
      role: message.role,
      content: typeof message.content === 'string'
        ? message.content
        : message.content.map(part => part.text).join(''),
    }))),
  ].join('\n');
}
