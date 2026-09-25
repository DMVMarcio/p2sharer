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
        <button type="submit" className="btn-chat-send" title="Enviar Mensagem">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" x2="11" y1="2" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </form>
    </div>
  );
};
