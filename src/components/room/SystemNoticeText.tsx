import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React from 'react';
import type { ChatMessage } from '../../core/types.ts';
import { getRoomApp } from '../../apps/registry';

interface SystemNoticeTextProps {
  message: ChatMessage;
}

export const SystemNoticeText: React.FC<SystemNoticeTextProps> = ({ message }) => {
  useLocale();
  const roomName = message.systemRoom && message.text.startsWith('Sala criada: ')
    ? message.text.slice('Sala criada: '.length) : message.systemRoom;
  const appName = message.systemAppKind ? getRoomApp(message.systemAppKind)?.label : undefined;
  const displayText = message.systemType === 'join' && message.systemActor ? t('notice.join', { actor: message.systemActor })
    : message.systemType === 'leave' && message.systemActor ? t('notice.leave', { actor: message.systemActor })
    : message.systemType === 'stream-start' && message.systemActor ? t('notice.streamStart', { actor: message.systemActor })
    : message.systemType === 'stream-stop' && message.systemActor ? t('notice.streamStop', { actor: message.systemActor })
    : message.systemType === 'app-start' && message.systemActor && appName ? t('notice.appStart', { actor: message.systemActor, app: appName })
    : message.systemType === 'app-stop' && message.systemActor && appName ? t('notice.appStop', { actor: message.systemActor, app: appName })
    : message.systemType === 'info' && message.systemActor && message.text.startsWith('Senha alterada por ') ? t('notice.password', { actor: message.systemActor })
    : message.systemType === 'info' && roomName && message.text.startsWith('Sala criada: ') ? t('notice.roomCreated', { room: roomName })
    : message.text;
  const terms = [message.systemActor, roomName, appName]
    .filter((term): term is string => Boolean(term))
    .sort((a, b) => b.length - a.length);
  if (!terms.length) return <>{displayText}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  while (cursor < displayText.length) {
    const matches = terms.map((term) => ({ term, index: displayText.indexOf(term, cursor) }))
      .filter(({ index }) => index >= 0)
      .sort((a, b) => a.index - b.index || b.term.length - a.term.length);
    if (!matches.length) break;
    const { term, index } = matches[0];
    if (index > cursor) parts.push(displayText.slice(cursor, index));
    parts.push(<strong className="chat-sys-highlight" key={`${index}-${term}`}>{term}</strong>);
    cursor = index + term.length;
  }
  if (cursor < displayText.length) parts.push(displayText.slice(cursor));
  return <>{parts}</>;
};
