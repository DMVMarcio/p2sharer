import { Copy, Download, Pencil, Reply, Trash2 } from 'lucide-react';
import { type ContextMenuAction } from '../common/ContextMenu';

export interface ChatMessageActionsProps {
  own: boolean;
  onReply: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSaveAs?: () => void;
  isFile?: boolean;
}

/** Shared by the message's dots button and its right-click shortcut. */
export function getChatMessageActions({ own, onReply, onCopy, onEdit, onDelete, onSaveAs, isFile }: ChatMessageActionsProps): ContextMenuAction[] {
  const actions: ContextMenuAction[] = [{ id: 'reply', label: 'Responder', icon: <Reply size={15} />, onSelect: onReply }];
  if (isFile && onSaveAs && !own) actions.push({ id: 'save', label: 'Salvar Como', icon: <Download size={15} />, onSelect: onSaveAs });
  if (!isFile) actions.push({ id: 'copy', label: 'Copiar Texto', icon: <Copy size={15} />, onSelect: onCopy });
  if (own) {
    if (!isFile) actions.push({ id: 'edit', label: 'Editar', icon: <Pencil size={15} />, onSelect: onEdit });
    actions.push({ id: 'delete', label: 'Excluir', icon: <Trash2 size={15} />, danger: true, onSelect: onDelete });
  }
  return actions;
}
