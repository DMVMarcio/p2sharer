import { Pointer, MousePointer2, TextCursor } from 'lucide-react';

export function VirtualCursorGlyph({ shape = 'default' }: { shape?: 'default' | 'text' | 'pointer' }) {
  return shape === 'text' ? <TextCursor size={20} className="virtual-cursor-text" aria-hidden="true" />
    : shape === 'pointer' ? <Pointer size={20} fill="var(--accent-color)" aria-hidden="true" />
      : <MousePointer2 size={20} fill="var(--accent-color)" aria-hidden="true" />;
}
