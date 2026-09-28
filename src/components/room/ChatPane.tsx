import React, { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { useRoom } from '../../hooks/useRoom';
import { EmojiPicker } from '../common/EmojiPicker';
import { EmojiComposerInput, type EmojiComposerHandle } from '../common/EmojiComposerInput';
import { ChatMessageContent } from '../common/ChatMessageContent';
import { getEmojiPack, subscribeEmojiPack } from '../../core/emoji_preferences';
import { SystemNoticeIcon } from './SystemNoticeIcon';
import { SystemNoticeText } from './SystemNoticeText';

export const ChatPane: React.FC = () => {
  const { chatMessages, sendChatMessage } = useRoom();
  const [inputText, setInputText] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const emojiPack = useSyncExternalStore(subscribeEmojiPack, getEmojiPack);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<EmojiComposerHandle>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

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
    if (!inputText.trim()) return;
    sendChatMessage(inputText);
    setInputText('');
    setPickerOpen(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage();
  };

  return (
    <div className="sidebar-tab-content active" id="tab-content-chat">
      <div className="chat-messages-container" id="chat-messages-container">
        {chatMessages.map((msg, index) => {
          const timeStr = new Date(msg.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          });

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
            <div key={msg.id || index} className="chat-msg">
              <div className="chat-msg-header">
                <span className="chat-msg-sender">{msg.sender}</span>
                {msg.isHost && <span className="badge-host">HOST</span>}
                <span className="chat-msg-time">{timeStr}</span>
              </div>
              <div className="chat-msg-bubble"><ChatMessageContent text={msg.text} pack={emojiPack} /></div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-composer" ref={composerRef}>
      {pickerOpen && <EmojiPicker pack={emojiPack} onSelect={insertEmoji} />}
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
