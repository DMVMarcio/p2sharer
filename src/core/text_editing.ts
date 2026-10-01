import type { Editor } from '@tiptap/core';

export const TEXT_EDITOR_SELECTOR = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="tel"], input[type="email"], input[type="number"], input[type="password"], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], .ProseMirror';
const editors = new WeakMap<HTMLElement, Editor>();

export function registerTextEditor(editor: Editor) {
  const element = editor.view.dom;
  editors.set(element, editor);
  return () => { if (editors.get(element) === editor) editors.delete(element); };
}

export interface TextEditingSession {
  source: HTMLElement;
  selectedText: string;
  editable: boolean;
  canCopy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasText: boolean;
  restore: () => void;
  insertText: (text: string) => void;
  deleteSelection: () => void;
  undo: () => void;
  redo: () => void;
  selectAll: () => void;
}

const commandEnabled = (command: string) => document.queryCommandEnabled?.(command) ?? false;

/** Capture before the menu takes focus; mutations run through the editor's own history. */
export function captureTextEditing(target: EventTarget | null): TextEditingSession | null {
  const source = target instanceof Element ? target.closest<HTMLElement>(TEXT_EDITOR_SELECTOR) : null;
  if (!source) return null;
  const editor = editors.get(source);
  if (editor && !editor.isDestroyed) {
    const initialDocument = editor.state.doc;
    const { from, to } = editor.state.selection;
    const restore = () => {
      if (editor.isDestroyed || !source.isConnected) throw new Error('Editor is no longer available');
      if (editor.state.doc !== initialDocument) throw new Error('Editor changed while the menu was open');
      editor.commands.setTextSelection({ from: Math.min(from, editor.state.doc.content.size), to: Math.min(to, editor.state.doc.content.size) });
      editor.view.focus();
    };
    return { source, selectedText: editor.state.doc.textBetween(from, to, '\n'), editable: editor.isEditable,
      canCopy: from !== to, canUndo: editor.isEditable && editor.can().undo(), canRedo: editor.isEditable && editor.can().redo(), hasText: !editor.isEmpty,
      restore,
      insertText: (text) => { restore(); if (editor.isEditable) editor.view.pasteText(text); },
      deleteSelection: () => { restore(); if (editor.isEditable) editor.commands.deleteSelection(); },
      undo: () => { restore(); if (editor.isEditable) editor.commands.undo(); },
      redo: () => { restore(); if (editor.isEditable) editor.commands.redo(); },
      selectAll: () => { restore(); editor.commands.selectAll(); },
    };
  }

  const field = source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement ? source : null;
  const initialValue = field?.value;
  const start = field?.selectionStart;
  const end = field?.selectionEnd;
  const direction = field?.selectionDirection;
  const selection = window.getSelection();
  const range = !field && selection?.rangeCount && source.contains(selection.anchorNode) && source.contains(selection.focusNode)
    ? selection.getRangeAt(0).cloneRange() : null;
  const selectedText = field ? (start !== null && start !== undefined && end !== null && end !== undefined ? field.value.slice(start, end) : '') : range?.toString() ?? '';
  const editable = field ? !field.readOnly && !field.disabled : source.isContentEditable;
  const restore = () => {
    if (!source.isConnected || (field && field.value !== initialValue)) throw new Error('Editor changed while the menu was open');
    source.focus({ preventScroll: true });
    if (field && start !== null && start !== undefined && end !== null && end !== undefined) field.setSelectionRange(start, end, direction ?? undefined);
    else if (range) { const current = window.getSelection(); current?.removeAllRanges(); current?.addRange(range); }
  };
  const insertText = (text: string) => {
    restore();
    if (!editable) return;
    // WebView2 supports insertText for native fields, preserving its undo stack and React input events.
    if (document.execCommand?.('insertText', false, text)) return;
    if (!field) throw new Error('Text insertion is unavailable');
    const first = start ?? field.value.length;
    const last = end ?? first;
    let value = field.value.slice(0, first) + text + field.value.slice(last);
    if (field.maxLength >= 0) value = value.slice(0, field.maxLength);
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set?.call(field, value);
    if (start !== null && start !== undefined) field.setSelectionRange(Math.min(first + text.length, value.length), Math.min(first + text.length, value.length));
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: text ? 'insertText' : 'deleteContentBackward', data: text }));
  };
  return { source, selectedText, editable,
    canCopy: field instanceof HTMLInputElement && field.type === 'password' ? false : Boolean(selectedText) || commandEnabled('copy'),
    canUndo: editable && commandEnabled('undo'), canRedo: editable && commandEnabled('redo'),
    hasText: Boolean(field ? field.value : source.textContent), restore, insertText,
    deleteSelection: () => insertText(''),
    undo: () => { restore(); if (editable) document.execCommand('undo'); },
    redo: () => { restore(); if (editable) document.execCommand('redo'); },
    selectAll: () => {
      restore();
      if (field) field.select();
      else { const all = document.createRange(); all.selectNodeContents(source); const current = window.getSelection(); current?.removeAllRanges(); current?.addRange(all); }
    },
  };
}
