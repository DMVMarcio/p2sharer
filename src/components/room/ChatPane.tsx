import React, { useState, useEffect, useRef } from 'react';
import { useRoom } from '../../hooks/useRoom';

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
        <div className="chat-welcome-notice">
          <span>Conexão P2P criptografada direta entre os participantes.</span>
        </div>

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
                  {systemType === 'join' && (
                    <svg
                      className="chat-sys-icon join"
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                      <polyline points="10 17 15 12 10 7" />
                      <line x1="15" y1="12" x2="3" y2="12" />
                    </svg>
                  )}
                  {systemType === 'leave' && (
                    <svg
                      className="chat-sys-icon leave"
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                  )}
                  {(systemType === 'info' || systemType === 'generic') && (
                    <svg
                      className="chat-sys-icon info"
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                  )}
                  <span className="chat-sys-text">{msg.text}</span>
                  <span className="chat-sys-time">{timeStr}</span>
                </div>
              </div>
            );
          }

          return (
            <div key={msg.id || index} className="chat-msg">
              <div className="chat-msg-header">
                <span className="chat-msg-sender">{msg.sender}</span>
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
