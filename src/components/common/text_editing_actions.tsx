import { t } from '../../i18n';
import { Copy, Scissors, ClipboardPaste, Undo2, Redo2, TextSelect, Delete, TableRowsSplit, TableColumnsSplit, Trash2 } from 'lucide-react';
import type { ContextMenuAction } from './ContextMenu';
import type { TextEditingSession } from '../../core/text_editing';

export function getTextEditingActions(session: TextEditingSession): ContextMenuAction[] {
  const copy = async () => {
    session.restore();
    if (!document.execCommand?.('copy')) await navigator.clipboard.writeText(session.selectedText);
  };
  const actions: ContextMenuAction[] = [];
  const inTable = Boolean(session.editor?.isActive('table'));
  if (inTable && session.editor && session.editable) {
    actions.push(
      {
        id: 'table-add-row',
        get label() { return t("message.1877689abf19"); },
        icon: <TableRowsSplit size={15} />,
        submenu: [
          {
            id: 'table-add-row-before',
            get label() { return t('table.addAbove'); },
            icon: <TableRowsSplit size={15} />,
            onSelect: () => { session.restore(); session.editor?.chain().focus().addRowBefore().run(); },
          },
          {
            id: 'table-add-row-after',
            get label() { return t('table.addBelow'); },
            icon: <TableRowsSplit size={15} />,
            onSelect: () => { session.restore(); session.editor?.chain().focus().addRowAfter().run(); },
          },
        ],
      },
      {
        id: 'table-add-col',
        get label() { return t("message.d0dd6c4b7d03"); },
        icon: <TableColumnsSplit size={15} />,
        submenu: [
          {
            id: 'table-add-col-before',
            get label() { return t('table.addBefore'); },
            icon: <TableColumnsSplit size={15} />,
            onSelect: () => { session.restore(); session.editor?.chain().focus().addColumnBefore().run(); },
          },
          {
            id: 'table-add-col-after',
            get label() { return t('table.addAfter'); },
            icon: <TableColumnsSplit size={15} />,
            onSelect: () => { session.restore(); session.editor?.chain().focus().addColumnAfter().run(); },
          },
        ],
      },
      {
        id: 'table-delete-row',
        get label() { return t('table.deleteRow'); },
        icon: <Trash2 size={15} />,
        onSelect: () => { session.restore(); session.editor?.chain().focus().deleteRow().run(); },
      },
      {
        id: 'table-delete-col',
        get label() { return t('table.deleteColumn'); },
        icon: <Trash2 size={15} />,
        onSelect: () => { session.restore(); session.editor?.chain().focus().deleteColumn().run(); },
      },
      {
        id: 'table-delete',
        get label() { return t("message.4ecbd5fe56e9"); },
        icon: <Trash2 size={15} />,
        danger: true,
        onSelect: () => { session.restore(); session.editor?.chain().focus().deleteTable().run(); },
      },
    );
  }

  actions.push(
    { id: 'undo', get label() { return t("message.786b48222848"); }, icon: <Undo2 size={15} />, separator: inTable, disabled: !session.canUndo, onSelect: session.undo },
    { id: 'redo', get label() { return t("message.7b659c9caa5e"); }, icon: <Redo2 size={15} />, disabled: !session.canRedo, onSelect: session.redo },
    { id: 'cut', get label() { return t("message.b659da7fa50d"); }, icon: <Scissors size={15} />, separator: true, disabled: !session.editable || !session.canCopy,
      onSelect: async () => { await copy(); session.deleteSelection(); } },
    { id: 'copy', get label() { return t("message.39dcf1cbeb5a"); }, icon: <Copy size={15} />, disabled: !session.canCopy, onSelect: copy },
    { id: 'paste', get label() { return t("message.83229f4fb36b"); }, icon: <ClipboardPaste size={15} />, disabled: !session.editable || !navigator.clipboard?.readText,
      onSelect: async () => { const text = await navigator.clipboard.readText(); if (text) session.insertText(text); } },
    { id: 'delete', get label() { return t("message.87f3ff27960c"); }, icon: <Delete size={15} />, disabled: !session.editable || !session.selectedText, onSelect: session.deleteSelection },
    { id: 'select-all', get label() { return t("message.6dc56b9dcaea"); }, icon: <TextSelect size={15} />, separator: true, disabled: !session.hasText, onSelect: session.selectAll },
  );

  return actions;
}
