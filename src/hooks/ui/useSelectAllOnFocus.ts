import { useRef, type PointerEvent, type MouseEvent, type FocusEvent } from 'react';

/** First activation selects the address; subsequent clicks use normal caret placement. */
export function useSelectAllOnFocus() {
  const firstClick = useRef(false);
  return {
    onPointerDown(event: PointerEvent<HTMLInputElement>) {
      firstClick.current = event.button === 0 && document.activeElement !== event.currentTarget;
      if (firstClick.current) { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.select(); }
    },
    onClick(event: MouseEvent<HTMLInputElement>) {
      if (firstClick.current) { event.currentTarget.select(); firstClick.current = false; }
    },
    onFocus(event: FocusEvent<HTMLInputElement>) { event.currentTarget.select(); },
    onBlur() { firstClick.current = false; },
  };
}
