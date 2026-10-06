import type { ChatMessage } from './types.ts';

export function shouldPlayChatSound(appFocused: boolean, sidebarCollapsed: boolean, sidebarTab: string): boolean {
  return !appFocused || sidebarCollapsed || sidebarTab !== 'chat';
}

/** Live deliveries only; history synchronization never enters this policy. */
export function shouldNotifyChat(message: ChatMessage, known: ChatMessage[], localPeerId: string): boolean {
  return !message.isSystem && !message.deletedAt && !message.editedAt &&
    !message.revision && message.authorId !== localPeerId &&
    !known.some((item) => item.id === message.id);
}
