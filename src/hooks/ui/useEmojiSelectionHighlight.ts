import { useEffect, useRef, type RefObject } from 'react';

const EMOJI_SELECTOR = '.emoji-glyph, .chat-editor-emoji';

export function useEmojiSelectionHighlight(rootRef: RefObject<HTMLElement | null>) {
  const highlightedRef = useRef(new Set<HTMLElement>());

  useEffect(() => {
    const syncHighlight = () => {
      const root = rootRef.current;
      const selection = document.getSelection();
      const highlighted = new Set<HTMLElement>();
      if (root && selection && !selection.isCollapsed && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        if (range.intersectsNode(root)) {
          root.querySelectorAll<HTMLElement>(EMOJI_SELECTOR).forEach((glyph) => {
            if (range.intersectsNode(glyph)) highlighted.add(glyph);
          });
        }
      }
      for (const glyph of highlightedRef.current) {
        if (!highlighted.has(glyph)) glyph.classList.remove('emoji-selected');
      }
      for (const glyph of highlighted) glyph.classList.add('emoji-selected');
      highlightedRef.current = highlighted;
    };

    document.addEventListener('selectionchange', syncHighlight);
    return () => {
      document.removeEventListener('selectionchange', syncHighlight);
      for (const glyph of highlightedRef.current) glyph.classList.remove('emoji-selected');
      highlightedRef.current.clear();
    };
  }, [rootRef]);
}
