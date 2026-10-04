import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React from 'react';

export const UnreadChatBadge: React.FC<{ count: number }> = ({ count }) => { useLocale(); return count > 0 ? (
  <span className="chat-unread-badge" role="status" aria-label={t('chat.unread', { count })}>
    {count > 99 ? '99+' : count}
  </span>
) : null; };
