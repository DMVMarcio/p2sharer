import React, { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { useRoom } from '../../hooks/useRoom';
import { EmojiPicker } from '../common/EmojiPicker';
import { EmojiComposerInput, type EmojiComposerHandle } from '../common/EmojiComposerInput';
import { ChatMessageContent } from '../common/ChatMessageContent';
import { getEmojiPack, subscribeEmojiPack } from '../../core/emoji_preferences';
import { SystemNoticeIcon } from './SystemNoticeIcon';
import { SystemNoticeText } from './SystemNoticeText';
import { useEmojiSelectionHighlight } from '../../hooks/useEmojiSelectionHighlight';
import { ChatMessageMenu } from './ChatMessageMenu';
import { Reply, X } from 'lucide-react';
import { selfId } from '@trystero-p2p/core';
import { showToast } from '../../hooks/useToast';

export const ChatPane: React.FC = () => {
  const { chatMessages, sendChatMessage, editChatMessage, deleteChatMessage } = useRoom();
  const [inputText, setInputText] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const emojiPack = useSyncExternalStore(subscribeEmojiPack, getEmojiPack);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<EmojiComposerHandle>(null);
  const editRef = useRef<EmojiComposerHandle>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  const composerRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  useEmojiSelectionHighlight(paneRef);

  const latestMessageId = chatMessages[chatMessages.length - 1]?.id;
  const replyMessage = chatMessages.find((message) => message.id === replyToId && !message.deletedAt);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [latestMessageId]);

  useEffect(() => {
    if (!openMenuId) return;
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target as Element).closest('.chat-msg-menu-wrap')) setOpenMenuId(null);
    };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenMenuId(null); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [openMenuId]);

  const jumpToMessage = (id: string) => {
    const target = messageRefs.current.get(id);
    if (!target) { showToast('Mensagem original não está disponível.'); return; }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedId(id);
    window.setTimeout(() => setHighlightedId((current) => current === id ? null : current), 1800);
  };

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pickerOpen]);

  const insertEmoji = (emoji: string) => {
    inputRef.current?.insertEmoji(emoji);
  };

  const sendMessage = () => {
    const composer = inputRef.current;
    if (!composer?.hasText()) return;
    sendChatMessage(composer.getMarkdown(), replyMessage?.id);
    setInputText('');
    setReplyToId(null);
    setPickerOpen(false);
  };

  const saveEdit = (id: string) => {
    const content = editRef.current?.getMarkdown() ?? editDraft;
    if (!content.trim()) { showToast('A mensagem não pode ficar vazia.'); return; }
    if (!editChatMessage(id, content)) { showToast('Não foi possível editar a mensagem.'); return; }
    setEditingId(null);
  };

  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text)
      .then(() => showToast('Texto copiado!'))
      .catch(() => showToast('Não foi possível copiar o texto.'));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage();
  };

  return (
    <div className="sidebar-tab-content active" id="tab-content-chat" ref={paneRef}>
      <div className="chat-messages-container" id="chat-messages-container">
        {chatMessages.map((msg, index) => {
          const timeStr = new Date(msg.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          });
          const repliedMessage = msg.replyTo ? chatMessages.find((item) => item.id === msg.replyTo?.id) : undefined;

          if (msg.isSystem || msg.sender === 'Sistema') {
            const systemType = msg.systemType || 'generic';
            return (
              <div
                key={msg.id || index}
                className={`chat-system-msg chat-system-${systemType}`}
                data-system-type={systemType}
              >
                <div className="chat-system-content">
                  <SystemNoticeIcon type={systemType} />
                  <span className="chat-sys-text"><SystemNoticeText message={msg} /></span>
                  <time className="chat-sys-time" dateTime={new Date(msg.timestamp).toISOString()}>{timeStr}</time>
                </div>
              </div>
            );
          }

          return (
            <div key={msg.id || index} className={`chat-msg ${highlightedId === msg.id ? 'chat-msg-highlighted' : ''}`} ref={(element) => { if (element) messageRefs.current.set(msg.id, element); else messageRefs.current.delete(msg.id); }}>
              <div className="chat-msg-header">
                <span className="chat-msg-sender">{msg.sender}</span>
                {msg.isHost && <span className="badge-host">HOST</span>}
                {msg.editedAt && !msg.deletedAt && <span className="chat-msg-edited">editada</span>}
                <span className="chat-msg-time">{timeStr}</span>
                {!msg.deletedAt && <ChatMessageMenu
                  open={openMenuId === msg.id}
                  own={msg.authorId === selfId}
                  onToggle={() => setOpenMenuId((current) => current === msg.id ? null : msg.id)}
                  onReply={() => { setReplyToId(msg.id); setOpenMenuId(null); inputRef.current?.focus(); }}
                  onCopy={() => { copyText(msg.text); setOpenMenuId(null); }}
                  onEdit={() => { setEditingId(msg.id); setEditDraft(msg.text); setOpenMenuId(null); }}
                  onDelete={() => { if (!deleteChatMessage(msg.id)) showToast('Não foi possível excluir a mensagem.'); setOpenMenuId(null); }}
                />}
              </div>
              <div className={`chat-msg-bubble ${msg.deletedAt ? 'chat-msg-deleted' : ''}`}>
                {!msg.deletedAt && msg.replyTo && <button type="button" className="chat-msg-reply" onClick={() => jumpToMessage(msg.replyTo!.id)}>
                  <span>{msg.replyTo.sender}</span>
                  <span>{repliedMessage?.deletedAt ? 'Mensagem excluída' : repliedMessage?.text ?? msg.replyTo.text}</span>
                </button>}
                {msg.deletedAt ? <span>Mensagem excluída</span> : editingId === msg.id ? <div className="chat-msg-edit">
                  <EmojiComposerInput id={`chat-edit-${msg.id}`} ref={editRef} value={editDraft} pack={emojiPack} onChange={setEditDraft} onSend={() => saveEdit(msg.id)} />
                  <div className="chat-msg-edit-actions">
                    <button type="button" onClick={() => setEditingId(null)}>Cancelar</button>
                    <button type="button" onClick={() => saveEdit(msg.id)}>Salvar</button>
                  </div>
                </div> : <ChatMessageContent text={msg.text} pack={emojiPack} />}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-composer" ref={composerRef}>
      {pickerOpen && <EmojiPicker pack={emojiPack} onSelect={insertEmoji} />}
      {replyMessage && <div className="chat-composer-reply">
        <Reply size={15} />
        <div><strong>Respondendo a {replyMessage.sender}</strong><span>{replyMessage.text}</span></div>
        <button type="button" aria-label="Cancelar resposta" onClick={() => setReplyToId(null)}><X size={16} /></button>
      </div>}
      <form className="chat-input-bar" id="chat-input-form" onSubmit={handleSubmit}>
        <button
          type="button"
          className={`btn-chat-emoji ${pickerOpen ? 'active' : ''}`}
          aria-label="Selecionar emoji"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((open) => !open)}
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01" strokeWidth="2.5"/>
          </svg>
        </button>
        <EmojiComposerInput
          ref={inputRef}
          value={inputText}
          pack={emojiPack}
          onChange={setInputText}
          onSend={sendMessage}
        />
        <button type="submit" className="btn-chat-send" aria-label="Enviar Mensagem">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" x2="11" y1="2" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </form>
      </div>
    </div>
  );
};
