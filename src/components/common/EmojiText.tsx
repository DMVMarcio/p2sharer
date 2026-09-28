import React from 'react';
import { getEmojiIndex } from '../../core/emoji_catalog';
import { EmojiPack } from '../../core/emoji_preferences';
import { EmojiGlyph } from './EmojiGlyph';

export const EmojiText: React.FC<{ text: string; pack: EmojiPack; size?: number }> = ({ text, pack, size = 16 }) => {
  const parts: React.ReactNode[] = [];
  let plainText = '';
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const { segment, index } of segmenter.segment(text)) {
    if (getEmojiIndex(segment) === undefined) {
      plainText += segment;
      continue;
    }
    if (plainText) parts.push(plainText);
    plainText = '';
    parts.push(<EmojiGlyph key={index} emoji={segment} pack={pack} size={size} />);
  }
  if (plainText) parts.push(plainText);
  return <>{parts}</>;
};
