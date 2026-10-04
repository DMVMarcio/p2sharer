import { t } from '../../i18n';
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
  const actions: ContextMenuAction[] = [{ id: 'reply', get label() { return t("message.8630a0dc25e2"); }, icon: <Reply size={15} />, onSelect: onReply }];
  if (isFile && onSaveAs && !own) actions.push({ id: 'save', get label() { return t("message.38d8e7eee23d"); }, icon: <Download size={15} />, onSelect: onSaveAs });
  if (!isFile) actions.push({ id: 'copy', get label() { return t("message.fd3fe5b385c4"); }, icon: <Copy size={15} />, onSelect: onCopy });
  if (own) {
    if (!isFile) actions.push({ id: 'edit', get label() { return t("message.2eba946b2e1e"); }, icon: <Pencil size={15} />, onSelect: onEdit });
    actions.push({ id: 'delete', get label() { return t("message.8b19518ff49b"); }, icon: <Trash2 size={15} />, danger: true, onSelect: onDelete });
  }
  return actions;
}
