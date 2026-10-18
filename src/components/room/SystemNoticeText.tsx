import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React from 'react';
import type { ChatMessage } from '../../core/types.ts';
import { getRoomApp } from '../../apps/registry';
import { modalManager } from '../../hooks/useModal';
import { stateStore } from '../../core/state_store';
import { profileImages } from '../../core/profile_image';

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

  let actorPeerId = message.authorId ?? '';
  const isActorLocal = Boolean(message.systemActor) && (actorPeerId === 'local' || message.systemActor === stateStore.username);
  if (message.systemActor && !actorPeerId) {
    if (isActorLocal) {
      actorPeerId = 'local';
    } else {
      const slot = stateStore.roomSlots.find((s) => s.senderName === message.systemActor);
      actorPeerId = slot?.peerId ?? '';
    }
  }
  const authorSlot = message.systemActor ? stateStore.roomSlots.find((s) => (s.ownerPeerId ?? s.peerId) === actorPeerId || (isActorLocal && s.isLocal)) : undefined;
  const actorColor = message.systemActor ? (authorSlot?.color ?? profileImages.color(actorPeerId, isActorLocal)) : undefined;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  while (cursor < displayText.length) {
    const matches = terms.map((term) => ({ term, index: displayText.indexOf(term, cursor) }))
      .filter(({ index }) => index >= 0)
      .sort((a, b) => a.index - b.index || b.term.length - a.term.length);
    if (!matches.length) break;
    const { term, index } = matches[0];
    if (index > cursor) parts.push(displayText.slice(cursor, index));
    if (term === message.systemActor) {
      parts.push(
        <strong className="chat-sys-highlight" key={`${index}-${term}`}>
          <button
            type="button"
            className="chat-sys-actor-btn"
            aria-label={t('profile.viewName', { name: term })}
            onClick={(event) => {
              event.stopPropagation();
              modalManager.openProfile({
                peerId: actorPeerId,
                name: term,
                isLocal: isActorLocal,
                color: actorColor,
              });
            }}
          >
            {term}
          </button>
        </strong>
      );
    } else {
      parts.push(<strong className="chat-sys-highlight" key={`${index}-${term}`}>{term}</strong>);
    }
    cursor = index + term.length;
  }
  if (cursor < displayText.length) parts.push(displayText.slice(cursor));
  return <>{parts}</>;
};
