import type { ChatMessage } from './types.ts';

export function mergeChatHistory(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of [...current, ...incoming]) {
    if (message && typeof message.id === 'string' && message.id &&
        typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) &&
        typeof message.text === 'string' && !byId.has(message.id)) {
      byId.set(message.id, message);
    }
  }
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}
