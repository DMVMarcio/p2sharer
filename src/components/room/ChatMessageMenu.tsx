import { Copy, MoreHorizontal, Pencil, Reply, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';

type Props = {
  open: boolean;
  own: boolean;
  onToggle: () => void;
  onReply: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

export function ChatMessageMenu({ open, own, onToggle, onReply, onCopy, onEdit, onDelete }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [up, setUp] = useState(false);
  const toggle = () => {
    const trigger = triggerRef.current;
    const container = trigger?.closest('.chat-messages-container');
    if (trigger && container) setUp(container.getBoundingClientRect().bottom - trigger.getBoundingClientRect().bottom < 170);
    onToggle();
  };
  return <div className="chat-msg-menu-wrap">
    <button ref={triggerRef} type="button" className="chat-msg-menu-trigger" aria-label="Ações da mensagem" aria-expanded={open} onClick={toggle}><MoreHorizontal size={17} /></button>
    {open && <div className={`chat-msg-menu ${up ? 'chat-msg-menu-up' : ''}`} role="menu">
      <button type="button" role="menuitem" onClick={onReply}><Reply size={15} /> Responder</button>
      <button type="button" role="menuitem" onClick={onCopy}><Copy size={15} /> Copiar Texto</button>
      {own && <>
        <button type="button" role="menuitem" onClick={onEdit}><Pencil size={15} /> Editar</button>
        <button type="button" role="menuitem" className="chat-msg-delete" onClick={onDelete}><Trash2 size={15} /> Excluir</button>
      </>}
    </div>}
  </div>;
}
