import { MoreHorizontal } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { isContextMenuEditor, useContextMenu } from '../common/ContextMenu';
import { getChatMessageActions, type ChatMessageActionsProps } from './chat_message_actions';

type Props = ChatMessageActionsProps;

export function ChatMessageMenu(props: Props) {
  const openMenu = useContextMenu();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const actions = getChatMessageActions(props);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => {
    const message = triggerRef.current?.closest<HTMLElement>('.chat-msg');
    if (!message) return;
    const context = (event: MouseEvent) => {
      if (!isContextMenuEditor(event.target)) openMenu(event, actionsRef.current);
    };
    message.addEventListener('contextmenu', context);
    return () => message.removeEventListener('contextmenu', context);
  }, [openMenu]);
  return <div className="chat-msg-menu-wrap">
    <button ref={triggerRef} type="button" className="chat-msg-menu-trigger" aria-label="Ações da mensagem"
      aria-haspopup="menu" onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        openMenu({ ...event, clientX: rect.right, clientY: rect.bottom, currentTarget: event.currentTarget,
          preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() }, actions);
      }}><MoreHorizontal size={17} /></button>
  </div>;
}
