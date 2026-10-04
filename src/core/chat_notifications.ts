import type { ChatMessage } from './types.ts';

/** Live deliveries only; history synchronization never enters this policy. */
export function shouldNotifyChat(message: ChatMessage, known: ChatMessage[], localPeerId: string): boolean {
  return !message.isSystem && !message.deletedAt && !message.editedAt &&
    !message.revision && message.authorId !== localPeerId &&
    !known.some((item) => item.id === message.id);
}
