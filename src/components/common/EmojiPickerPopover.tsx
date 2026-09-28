import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EmojiPack } from '../../core/emoji_preferences';
import { calculateTooltipPosition } from './tooltip_utils';
import { EmojiPicker } from './EmojiPicker';

type Props = {
  anchor: HTMLElement | null;
  pack: EmojiPack;
  onSelect: (emoji: string) => void;
};

export function EmojiPickerPopover({ anchor, pack, onSelect }: Props) {
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const updatePosition = () => {
      const width = Math.min(340, window.innerWidth - 16);
      const height = Math.min(370, window.innerHeight * 0.55);
      const { top, left } = calculateTooltipPosition({
        triggerRect: anchor.getBoundingClientRect(),
        tooltipRect: { width, height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        placement: 'auto', padding: 8, gap: 6,
      });
      setPosition({ top, left, width });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    document.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchor]);

  if (!position) return null;
  return createPortal(
    <div className="emoji-picker-popover" style={position}><EmojiPicker pack={pack} onSelect={onSelect} /></div>,
    document.body,
  );
}
