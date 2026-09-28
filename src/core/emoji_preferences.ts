export const EMOJI_PACKS = [
  { id: 'twemoji', name: 'Twemoji', description: 'Visual colorido e familiar.' },
  { id: 'classic', name: 'EmojiOne 2.2', description: 'Arte clássica © Ranks.com, CC BY 4.0.' },
  { id: 'noto', name: 'Noto Emoji', description: 'Estilo do Google.' },
  { id: 'openmoji', name: 'OpenMoji', description: 'Traços marcados e cores vivas.' },
  { id: 'native', name: 'Sistema', description: 'Emojis da fonte do seu dispositivo.' },
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
