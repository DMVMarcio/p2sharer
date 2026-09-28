import rawCatalog from './emoji_catalog.json';

export const EMOJI_CATEGORIES = [
  { id: 'Smileys & Emotion', label: 'Rostos e emoções', icon: '😀' },
  { id: 'People & Body', label: 'Pessoas e gestos', icon: '👋' },
  { id: 'Animals & Nature', label: 'Animais e natureza', icon: '🐶' },
  { id: 'Food & Drink', label: 'Comidas e bebidas', icon: '🍕' },
  { id: 'Travel & Places', label: 'Viagem e lugares', icon: '🚗' },
  { id: 'Activities', label: 'Atividades', icon: '⚽' },
  { id: 'Objects', label: 'Objetos', icon: '💡' },
  { id: 'Symbols', label: 'Símbolos', icon: '❤️' },
  { id: 'Flags', label: 'Bandeiras', icon: '🏳️' },
] as const;

export type EmojiCategory = (typeof EMOJI_CATEGORIES)[number]['id'];
export type EmojiEntry = { emoji: string; alternate: string | null; name: string; category: string; classic: boolean };
export const EMOJI_CATALOG: EmojiEntry[] = rawCatalog;

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
