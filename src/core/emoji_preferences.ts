import { t } from '../i18n/index.ts';
export const EMOJI_PACKS = [
  { id: 'twemoji', name: 'Twemoji', get description() { return t("message.11806bf8d0e3"); } },
  { id: 'classic', name: 'EmojiOne 2.2', get description() { return t("message.d880876bcdff"); } },
  { id: 'noto', name: 'Noto Emoji', get description() { return t("message.1a1ae07f6929"); } },
  { id: 'openmoji', name: 'OpenMoji', get description() { return t("message.6d2aacbdd410"); } },
  { id: 'native', get name() { return t("message.f150afd3c599"); }, get description() { return t("message.1384a05883f2"); } },
] as const;

export type EmojiPack = (typeof EMOJI_PACKS)[number]['id'];

const STORAGE_KEY = 'p2sharer_emoji_pack';
const CHANGE_EVENT = 'p2sharer-emoji-pack-change';

export function getEmojiPack(): EmojiPack {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'retro') return 'classic';
  return EMOJI_PACKS.find((pack) => pack.id === saved)?.id ?? 'twemoji';
}

export function saveEmojiPack(pack: EmojiPack): void {
  localStorage.setItem(STORAGE_KEY, pack);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeEmojiPack(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}
