import React from 'react';

export const UnreadChatBadge: React.FC<{ count: number }> = ({ count }) => count > 0 ? (
  <span className="chat-unread-badge" role="status" aria-label={`${count} mensagens não lidas`}>
    {count > 99 ? '99+' : count}
  </span>
) : null;
