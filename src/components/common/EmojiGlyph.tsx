import React from 'react';
import { EmojiPack } from '../../core/emoji_preferences';
import { EMOJI_CATALOG, getEmojiIndex } from '../../core/emoji_catalog';

type Props = { emoji: string; pack: EmojiPack; size?: number; label?: string };

export const EmojiGlyph: React.FC<Props> = ({ emoji, pack, size = 22, label }) => {
  const index = getEmojiIndex(emoji);
  if (pack === 'native' || index === undefined || (pack === 'classic' && !EMOJI_CATALOG[index].classic)) {
    return <span className="emoji-glyph emoji-glyph-native" role={label ? 'img' : undefined} aria-label={label} style={{ fontSize: size, lineHeight: 1 }}>{emoji}</span>;
  }

  return (
    <span
      className={`emoji-glyph emoji-glyph-image emoji-pack-${pack}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      style={{
        width: size,
        height: size,
        backgroundSize: `${size * 16}px auto`,
        backgroundPosition: `${-(index % 16) * size}px ${-Math.floor(index / 16) * size}px`,
      }}
    >{emoji}</span>
  );
};
