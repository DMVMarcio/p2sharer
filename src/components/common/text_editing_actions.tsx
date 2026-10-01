import { Copy, Scissors, ClipboardPaste, Undo2, Redo2, TextSelect, Delete } from 'lucide-react';
import type { ContextMenuAction } from './ContextMenu';
import type { TextEditingSession } from '../../core/text_editing';

export function getTextEditingActions(session: TextEditingSession): ContextMenuAction[] {
  const copy = async () => {
    session.restore();
    if (!document.execCommand?.('copy')) await navigator.clipboard.writeText(session.selectedText);
  };
  return [
    { id: 'undo', label: 'Desfazer', icon: <Undo2 size={15} />, disabled: !session.canUndo, onSelect: session.undo },
    { id: 'redo', label: 'Refazer', icon: <Redo2 size={15} />, disabled: !session.canRedo, onSelect: session.redo },
    { id: 'cut', label: 'Recortar', icon: <Scissors size={15} />, separator: true, disabled: !session.editable || !session.canCopy,
      onSelect: async () => { await copy(); session.deleteSelection(); } },
    { id: 'copy', label: 'Copiar', icon: <Copy size={15} />, disabled: !session.canCopy, onSelect: copy },
    { id: 'paste', label: 'Colar', icon: <ClipboardPaste size={15} />, disabled: !session.editable || !navigator.clipboard?.readText,
      onSelect: async () => { const text = await navigator.clipboard.readText(); if (text) session.insertText(text); } },
    { id: 'delete', label: 'Excluir seleção', icon: <Delete size={15} />, disabled: !session.editable || !session.selectedText, onSelect: session.deleteSelection },
    { id: 'select-all', label: 'Selecionar tudo', icon: <TextSelect size={15} />, separator: true, disabled: !session.hasText, onSelect: session.selectAll },
  ];
}
