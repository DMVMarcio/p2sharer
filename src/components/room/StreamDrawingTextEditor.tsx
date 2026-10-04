import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { StreamDrawing } from '../../core/stream_pointer';

/** Borderless native text editing anchored to the shared video projection. */
export function StreamDrawingTextEditor({ drawing, bounds, inputRef, onConfirm }: {
  drawing: StreamDrawing; bounds: { left: number; top: number; width: number; height: number };
  onConfirm: (drawing: StreamDrawing) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  useLocale();
  const localInput = useRef<HTMLTextAreaElement>(null);
  const input = inputRef ?? localInput;
  const confirmed = useRef(false);
  const [text, setText] = useState('');
  const fontSize = (14 + drawing.size * 5) * Math.min(bounds.width, bounds.height) / 1080;
  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = '0px';
    input.current.style.height = `${Math.max(fontSize * 1.2, input.current.scrollHeight)}px`;
  }, [text, fontSize]);
  const confirm = () => {
    if (confirmed.current) return;
    confirmed.current = true;
    onConfirm({ ...drawing, text: input.current?.value ?? text });
  };
  return <textarea ref={input} className="text-input stream-drawing-text-editor" aria-label={t("message.ba7f73248c3a")}
    autoComplete="off" spellCheck={false} maxLength={160} wrap="off" value={text}
    style={{ left: bounds.left + drawing.points[0].x * bounds.width, top: bounds.top + drawing.points[0].y * bounds.height,
      width: Math.max(fontSize, (1 - drawing.points[0].x) * bounds.width), fontSize, color: drawing.color, caretColor: drawing.color }}
    onChange={event => setText(event.target.value)} onBlur={event => {
      // The canonical editing menu temporarily takes focus to expose copy/paste.
      if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('[role="menu"]'))) confirm();
    }}
    onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); confirm(); }
    }} />;
}
