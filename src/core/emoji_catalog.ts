import { t } from '../i18n/index.ts';
import rawCatalog from './emoji_catalog.json';

export const EMOJI_CATEGORIES = [
  { id: 'Smileys & Emotion', get label() { return t("message.0a037b469d8c"); } },
  { id: 'People & Body', get label() { return t("message.15b057d67370"); } },
  { id: 'Animals & Nature', get label() { return t("message.98eb235e54de"); } },
  { id: 'Food & Drink', get label() { return t("message.5b6669f1ea16"); } },
  { id: 'Travel & Places', get label() { return t("message.0ecbcc4ceaa7"); } },
  { id: 'Activities', get label() { return t("message.dff6624256ba"); } },
  { id: 'Objects', get label() { return t("message.54a54a384ffb"); } },
  { id: 'Symbols', get label() { return t("message.817d1527dad8"); } },
  { id: 'Flags', get label() { return t("message.2a086b4f697f"); } },
] as const;

export type EmojiCategory = (typeof EMOJI_CATEGORIES)[number]['id'];
export type EmojiEntry = { emoji: string; alternate: string | null; name: string; category: string; classic: boolean };
export const EMOJI_CATALOG: EmojiEntry[] = rawCatalog;

export function getEmojiName(entry: EmojiEntry): string { return t(`emoji.${entry.emoji}`); }

export const EMOJI_SEARCH_ALIASES: Record<string, string> = {
  '😀': 'sorriso feliz rosto', '😂': 'risada chorando rir', '🤣': 'gargalhada risada',
  '😍': 'apaixonado amor', '🥰': 'amor carinho', '😘': 'beijo', '😭': 'choro triste',
  '😢': 'triste choro', '😡': 'raiva bravo', '🤔': 'pensando duvida', '😎': 'oculos legal',
  '👍': 'joinha positivo aprovar', '👎': 'negativo desaprovar', '👏': 'palmas aplausos',
  '🙏': 'obrigado por favor oracao', '👋': 'oi tchau aceno', '❤️': 'coracao amor',
  '💔': 'coracao partido', '💖': 'coracao brilhante', '🔥': 'fogo chama',
  '🎉': 'festa comemoracao confete', '🎂': 'bolo aniversario', '🎁': 'presente',
  '🐶': 'cachorro cao', '🐱': 'gato', '🍕': 'pizza', '🍔': 'hamburguer',
  '🍺': 'cerveja', '☕': 'cafe', '⚽': 'futebol bola', '🎮': 'jogo videogame',
  '🚗': 'carro', '✈️': 'aviao viagem', '🏠': 'casa', '💡': 'lampada ideia',
  '📱': 'celular telefone', '🇧🇷': 'brasil bandeira', '🇵🇹': 'portugal bandeira',
};

const emojiIndexes = new Map<string, number>();
EMOJI_CATALOG.forEach((entry, index) => {
  emojiIndexes.set(entry.emoji, index);
  if (entry.alternate) emojiIndexes.set(entry.alternate, index);
});

export function getEmojiIndex(emoji: string): number | undefined {
  return emojiIndexes.get(emoji);
}
