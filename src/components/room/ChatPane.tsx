import React, { useState, useEffect, useRef } from 'react';
import { useRoom } from '../../hooks/useRoom';
import { SystemNoticeIcon } from './SystemNoticeIcon';
import { SystemNoticeText } from './SystemNoticeText';

export const ChatPane: React.FC = () => {
  const { chatMessages, sendChatMessage } = useRoom();
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    sendChatMessage(inputText);
    setInputText('');
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
                  <span className="chat-sys-text" title={msg.text}><SystemNoticeText message={msg} /></span>
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
              <div className="chat-msg-bubble">{msg.text}</div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <form className="chat-input-bar" id="chat-input-form" onSubmit={handleSubmit}>
        <input
          type="text"
          id="chat-input-field"
          placeholder="Digite uma mensagem..."
          autoComplete="off"
          maxLength={300}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
        />
        <button type="submit" className="btn-chat-send" aria-label="Enviar Mensagem">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" x2="11" y1="2" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </form>
    </div>
  );
};
