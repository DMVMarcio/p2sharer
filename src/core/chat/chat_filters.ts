import type { ChatMessage } from '../types.ts';

export const CHAT_FILTERS_STORAGE_KEY = 'p2sharer_chat_filters_v1';

export type ChatFilterCategory = 'messages' | 'apps' | 'streams' | 'presence' | 'events';

export type ChatFilterPreferences = Record<ChatFilterCategory, boolean>;

export const DEFAULT_CHAT_FILTERS: ChatFilterPreferences = {
  messages: true,
  apps: true,
  streams: true,
  presence: true,
  events: true,
};

const listeners = new Set<() => void>();

function readChatFilters(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): ChatFilterPreferences {
  if (!storage) return { ...DEFAULT_CHAT_FILTERS };
  try {
    const raw = storage.getItem(CHAT_FILTERS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CHAT_FILTERS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_CHAT_FILTERS };
    return {
      messages: typeof parsed.messages === 'boolean' ? parsed.messages : true,
      apps: typeof parsed.apps === 'boolean' ? parsed.apps : true,
      streams: typeof parsed.streams === 'boolean' ? parsed.streams : true,
      presence: typeof parsed.presence === 'boolean' ? parsed.presence : true,
      events: typeof parsed.events === 'boolean' ? parsed.events : true,
    };
  } catch {
    return { ...DEFAULT_CHAT_FILTERS };
  }
}

let cachedFilters: ChatFilterPreferences = readChatFilters();

export function getChatFilters(): ChatFilterPreferences {
  return cachedFilters;
}

export function setChatFilter(category: ChatFilterCategory, enabled: boolean): void {
  const next: ChatFilterPreferences = { ...cachedFilters, [category]: enabled };
  cachedFilters = next;
  try {
    globalThis.localStorage?.setItem(CHAT_FILTERS_STORAGE_KEY, JSON.stringify(next));
  } catch {}
  listeners.forEach((listener) => listener());
}

export function resetChatFilters(): void {
  cachedFilters = { ...DEFAULT_CHAT_FILTERS };
  try {
    globalThis.localStorage?.setItem(CHAT_FILTERS_STORAGE_KEY, JSON.stringify(cachedFilters));
  } catch {}
  listeners.forEach((listener) => listener());
}

export function subscribeChatFilters(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getChatMessageCategory(message: ChatMessage): ChatFilterCategory {
  if (!message.isSystem && message.sender !== 'Sistema') return 'messages';
  switch (message.systemType) {
    case 'app-start':
    case 'app-stop':
      return 'apps';
    case 'stream-start':
    case 'stream-stop':
      return 'streams';
    case 'join':
    case 'leave':
      return 'presence';
    default:
      return 'events';
  }
}

export function matchesChatFilter(message: ChatMessage, filters: ChatFilterPreferences): boolean {
  return filters[getChatMessageCategory(message)];
}

export function countHiddenChatCategories(filters: ChatFilterPreferences): number {
  return Object.values(filters).filter((enabled) => !enabled).length;
}
