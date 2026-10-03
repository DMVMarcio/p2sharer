import type { ChatMessage } from './types.ts';

export function hasSafeChatOrder(order: unknown): boolean {
  return order === undefined || (typeof order === 'number' && Number.isSafeInteger(order) && order > 0);
}

// Reserve before signing so concurrent local sends cannot reuse a sequence.
export function nextChatOrder(history: ChatMessage[], reserved = 0): number {
  const latest = history.reduce((order, message) => Math.max(order, message.logicalOrder ?? 0), reserved);
  if (latest >= Number.MAX_SAFE_INTEGER) throw new Error('Chat logical order exhausted');
  return latest + 1;
}

function compareChatMessages(a: ChatMessage, b: ChatMessage): number {
  const order = (a.logicalOrder ?? 0) - (b.logicalOrder ?? 0);
  if (order) return order;
  // Timestamp ordering is retained only for history without a logical sequence.
  if (a.logicalOrder === undefined && b.logicalOrder === undefined && a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

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
        hasSafeChatOrder(message.logicalOrder) &&
        typeof message.text === 'string' &&
        (message.revision === undefined || (Number.isInteger(message.revision) && message.revision >= 0))) {
      const existing = byId.get(message.id);
      if (!existing) {
        byId.set(message.id, message);
      } else if (existing.authorId === message.authorId &&
                 existing.authorKey === message.authorKey &&
                 existing.timestamp === message.timestamp &&
                 existing.logicalOrder === message.logicalOrder &&
                 existing.deletedAt === undefined &&
                 chatRevision(message) > chatRevision(existing)) {
        byId.set(message.id, message);
      }
    }
  }
  return [...byId.values()].sort(compareChatMessages);
}
