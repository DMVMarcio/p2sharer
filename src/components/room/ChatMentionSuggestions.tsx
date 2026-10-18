import React, { useEffect, useRef } from 'react';
import { ProfileAvatar } from '../common/ProfileAvatar';
import { Nickname } from '../common/Nickname';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';

export interface MentionCandidate {
  peerId: string;
  name: string;
  color?: string;
  isLocal?: boolean;
  isHost?: boolean;
  isAdmin?: boolean;
}

interface ChatMentionSuggestionsProps {
  candidates: MentionCandidate[];
  selectedIndex: number;
  onSelect: (candidate: MentionCandidate) => void;
}

export const ChatMentionSuggestions: React.FC<ChatMentionSuggestionsProps> = ({
  candidates,
  selectedIndex,
  onSelect,
}) => {
  useLocale();
  const activeItemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (candidates.length === 0) return null;

  return (
    <div
      className="chat-mention-popover"
      role="listbox"
      id="chat-mention-listbox"
      aria-label={t('chat.mentionSuggestions')}
    >
      {candidates.map((candidate, index) => {
        const isSelected = index === selectedIndex;
        return (
          <button
            key={candidate.peerId || candidate.name}
            ref={isSelected ? activeItemRef : undefined}
            type="button"
            role="option"
            aria-selected={isSelected}
            className={`chat-mention-item ${isSelected ? 'active' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(candidate)}
          >
            <ProfileAvatar
              peerId={candidate.peerId}
              name={candidate.name}
              isLocal={candidate.isLocal}
              color={candidate.color}
              className="chat-mention-avatar"
            />
            <span className="chat-mention-name">
              <Nickname
                name={candidate.name}
                peerId={candidate.peerId}
                isLocal={candidate.isLocal}
                defaultColor={candidate.color}
              />
            </span>
            {candidate.isLocal && <span className="badge-you">{t('message.a03099f135b1')}</span>}
            {candidate.isHost && <span className="badge-host">{t('common.hostBadge')}</span>}
            {candidate.isAdmin && !candidate.isHost && <span className="badge-host">{t('common.adminBadge')}</span>}
          </button>
        );
      })}
    </div>
  );
};
