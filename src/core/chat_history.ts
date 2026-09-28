import type { ChatMessage } from './types.ts';

export function chatRevision(message: ChatMessage): number {
  return Number.isInteger(message.revision) && (message.revision ?? 0) >= 0 ? message.revision! : 0;
}

export function chatRevisionKey(message: ChatMessage): string {
  return `${message.id}:${chatRevision(message)}`;
}

export function chatHistoryChanged(current: ChatMessage[], next: ChatMessage[]): boolean {
  return current.length !== next.length || current.some((message, index) => message !== next[index]);
}

export function mergeChatHistory(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of [...current, ...incoming]) {
    if (message && typeof message.id === 'string' && message.id &&
        typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) &&
        typeof message.text === 'string' &&
        (message.revision === undefined || (Number.isInteger(message.revision) && message.revision >= 0))) {
      const existing = byId.get(message.id);
      if (!existing) {
        byId.set(message.id, message);
      } else if (existing.authorId === message.authorId &&
                 existing.deletedAt === undefined &&
                 chatRevision(message) > chatRevision(existing)) {
        byId.set(message.id, message);
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}
