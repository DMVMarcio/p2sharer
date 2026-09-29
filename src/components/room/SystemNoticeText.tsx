import React from 'react';
import type { ChatMessage } from '../../core/types.ts';
import { getRoomApp } from '../../apps/registry';

interface SystemNoticeTextProps {
  message: ChatMessage;
}

export const SystemNoticeText: React.FC<SystemNoticeTextProps> = ({ message }) => {
  const roomName = message.systemRoom && message.text.startsWith('Sala criada: ')
    ? message.text.slice('Sala criada: '.length) : message.systemRoom;
  const appName = message.systemAppKind ? getRoomApp(message.systemAppKind)?.label : undefined;
  const terms = [message.systemActor, roomName, appName]
    .filter((term): term is string => Boolean(term))
    .sort((a, b) => b.length - a.length);
  if (!terms.length) return <>{message.text}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  while (cursor < message.text.length) {
    const matches = terms.map((term) => ({ term, index: message.text.indexOf(term, cursor) }))
      .filter(({ index }) => index >= 0)
      .sort((a, b) => a.index - b.index || b.term.length - a.term.length);
    if (!matches.length) break;
    const { term, index } = matches[0];
    if (index > cursor) parts.push(message.text.slice(cursor, index));
    parts.push(<strong className="chat-sys-highlight" key={`${index}-${term}`}>{term}</strong>);
    cursor = index + term.length;
  }
  if (cursor < message.text.length) parts.push(message.text.slice(cursor));
  return <>{parts}</>;
};
