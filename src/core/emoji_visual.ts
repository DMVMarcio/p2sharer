import type { CSSProperties } from 'react';
import { getEmojiIndex } from './emoji_catalog';
import type { EmojiPack } from './emoji_preferences';

export function getEmojiVisual(emoji: string, pack: EmojiPack, size: number): { native: boolean; className: string; style: CSSProperties } {
  const index = getEmojiIndex(emoji);
  if (pack === 'native' || index === undefined) {
    return {
      native: true,
      className: 'emoji-glyph emoji-glyph-native',
      style: { width: size, height: size, fontSize: size * 0.88 },
    };
  }

  return {
    native: false,
    className: `emoji-glyph emoji-glyph-image emoji-pack-${pack}`,
    style: {
      width: size,
      height: size,
      backgroundSize: `${size * 16}px auto`,
      backgroundPosition: `${-(index % 16) * size}px ${-Math.floor(index / 16) * size}px`,
    },
  };
}
