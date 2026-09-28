import React from 'react';
import { EmojiPack } from '../../core/emoji_preferences';
import { getEmojiVisual } from '../../core/emoji_visual';

type Props = { emoji: string; pack: EmojiPack; size?: number; label?: string };

export const EmojiGlyph: React.FC<Props> = ({ emoji, pack, size = 22, label }) => {
  const visual = getEmojiVisual(emoji, pack, size);
  if (visual.native) return <span className={visual.className} role={label ? 'img' : undefined} aria-label={label} style={visual.style}>{emoji}</span>;

  return (
    <span
      className={visual.className}
      role={label ? 'img' : undefined}
      aria-label={label}
      style={visual.style}
    ><span className="emoji-glyph-copy">{emoji}</span></span>
  );
};
