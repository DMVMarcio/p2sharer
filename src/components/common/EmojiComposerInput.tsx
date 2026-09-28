import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { EmojiPack } from '../../core/emoji_preferences';
import { getEmojiIndex } from '../../core/emoji_catalog';
import { getEmojiVisual } from '../../core/emoji_visual';
import { ChatMessageContent } from './ChatMessageContent';

const MAX_LENGTH = 2000;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export type EmojiComposerHandle = {
  insertEmoji: (emoji: string) => void;
  focus: () => void;
};

type Props = {
  value: string;
  pack: EmojiPack;
  onChange: (value: string) => void;
  onSend: () => void;
};

type SelectionOffsets = { start: number; end: number };

function selectionOffsets(root: HTMLElement): SelectionOffsets | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  const range = selection.getRangeAt(0);
  const start = range.cloneRange();
  start.selectNodeContents(root);
  start.setEnd(range.startContainer, range.startOffset);
  const end = range.cloneRange();
  end.selectNodeContents(root);
  end.setEnd(range.endContainer, range.endOffset);
  return { start: start.toString().length, end: end.toString().length };
}

function textPosition(root: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let remaining = offset;
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      const atomic = node.parentElement?.closest('[contenteditable="false"]');
      if (atomic?.parentNode) {
        const index = Array.prototype.indexOf.call(atomic.parentNode.childNodes, atomic) as number;
        return { node: atomic.parentNode, offset: index + (remaining > 0 ? 1 : 0) };
      }
      return { node, offset: remaining };
    }
    remaining -= length;
    node = walker.nextNode();
  }
  return { node: root, offset: root.childNodes.length };
}

function restoreSelection(root: HTMLElement, offsets: SelectionOffsets) {
  const selection = window.getSelection();
  if (!selection) return;
  const start = textPosition(root, offsets.start);
  const end = textPosition(root, offsets.end);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

function renderContent(root: HTMLElement, value: string, pack: EmojiPack) {
  const fragment = document.createDocumentFragment();
  let plain = '';
  const flushPlain = () => {
    if (plain) fragment.append(document.createTextNode(plain));
    plain = '';
  };
  for (const { segment } of segmenter.segment(value)) {
    if (getEmojiIndex(segment) === undefined) {
      plain += segment;
      continue;
    }
    flushPlain();
    const visual = getEmojiVisual(segment, pack, 16);
    const glyph = document.createElement('span');
    glyph.className = visual.className;
    Object.assign(glyph.style, visual.style);
    glyph.contentEditable = 'false';
    if (visual.native) glyph.textContent = segment;
    else {
      const copy = document.createElement('span');
      copy.className = 'emoji-glyph-copy';
      copy.textContent = segment;
      glyph.append(copy);
    }
    fragment.append(glyph);
  }
  flushPlain();
  root.replaceChildren(fragment);
}

export const EmojiComposerInput = forwardRef<EmojiComposerHandle, Props>(function EmojiComposerInput({ value, pack, onChange, onSend }, ref) {
  const editorRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<SelectionOffsets>({ start: value.length, end: value.length });
  const composingRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  const updateEditor = (next: string, offsets: SelectionOffsets, notify = true) => {
    const root = editorRef.current;
    if (!root) return;
    const bounded = next.slice(0, MAX_LENGTH);
    renderContent(root, bounded, pack);
    root.dataset.pack = pack;
    valueRef.current = bounded;
    const position = Math.min(offsets.start, bounded.length);
    const end = Math.min(offsets.end, bounded.length);
    selectionRef.current = { start: position, end };
    restoreSelection(root, selectionRef.current);
    if (notify) onChange(bounded);
  };

  useLayoutEffect(() => {
    const root = editorRef.current;
    if (!root || composingRef.current || root.textContent === value && root.dataset.pack === pack) return;
    const offsets = document.activeElement === root ? selectionOffsets(root) ?? selectionRef.current : selectionRef.current;
    renderContent(root, value, pack);
    root.dataset.pack = pack;
    if (document.activeElement === root) restoreSelection(root, offsets);
  }, [value, pack]);

  useImperativeHandle(ref, () => ({
    insertEmoji(emoji) {
      const root = editorRef.current;
      if (!root) return;
      const { start, end } = selectionOffsets(root) ?? selectionRef.current;
      const next = valueRef.current.slice(0, start) + emoji + valueRef.current.slice(end);
      if (next.length > MAX_LENGTH) return;
      root.focus();
      updateEditor(next, { start: start + emoji.length, end: start + emoji.length });
    },
    focus() { editorRef.current?.focus(); },
  }));

  const syncFromDom = () => {
    if (composingRef.current) return;
    const root = editorRef.current;
    if (!root) return;
    const next = (root.textContent ?? '').replace(/\u00a0/g, ' ');
    const offsets = selectionOffsets(root) ?? selectionRef.current;
    updateEditor(next, offsets);
  };

  const insertText = (text: string) => {
    const root = editorRef.current;
    if (!root) return;
    const { start, end } = selectionOffsets(root) ?? selectionRef.current;
    const available = MAX_LENGTH - (valueRef.current.length - (end - start));
    const inserted = text.replace(/\r\n?/g, '\n').slice(0, available);
    const next = valueRef.current.slice(0, start) + inserted + valueRef.current.slice(end);
    updateEditor(next, { start: start + inserted.length, end: start + inserted.length });
  };

  return (
    <div className="chat-composer-field">
      <div
        ref={editorRef}
        id="chat-input-field"
        className="chat-composer-editor"
        role="textbox"
        aria-label="Mensagem"
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        data-placeholder="Digite uma mensagem..."
        onInput={syncFromDom}
        onKeyUp={() => { const root = editorRef.current; if (root) selectionRef.current = selectionOffsets(root) ?? selectionRef.current; }}
        onMouseUp={() => { const root = editorRef.current; if (root) selectionRef.current = selectionOffsets(root) ?? selectionRef.current; }}
        onBlur={() => { const root = editorRef.current; if (root) selectionRef.current = selectionOffsets(root) ?? selectionRef.current; }}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; syncFromDom(); }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (event.shiftKey) insertText('\n');
          else onSend();
        }}
        onPaste={(event) => {
          event.preventDefault();
          insertText(event.clipboardData.getData('text/plain'));
        }}
      />
      {value.trim() && (
        <div className="chat-composer-markdown-preview" aria-label="Prévia da mensagem">
          <span className="chat-composer-preview-label">Prévia</span>
          <div className="chat-msg-bubble"><ChatMessageContent text={value} pack={pack} /></div>
        </div>
      )}
    </div>
  );
});
