import { MoreHorizontal } from 'lucide-react';
import { useContextMenu } from '../common/ContextMenu';
import { getChatMessageActions, type ChatMessageActionsProps } from './chat_message_actions';

type Props = ChatMessageActionsProps;

export function ChatMessageMenu(props: Props) {
  const openMenu = useContextMenu();
  const actions = getChatMessageActions(props);
  return <div className="chat-msg-menu-wrap">
    <button type="button" className="chat-msg-menu-trigger" aria-label="Ações da mensagem"
      aria-haspopup="menu" onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        openMenu({ ...event, clientX: rect.right, clientY: rect.bottom, currentTarget: event.currentTarget,
          preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() }, actions);
      }}><MoreHorizontal size={17} /></button>
  </div>;
}
