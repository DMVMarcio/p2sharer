import { ProfileAvatar } from './profile/ProfileAvatar';
import { roomService } from '../../services/room_service';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React from 'react';
import { Tooltip } from './overlays/Tooltip';

export interface ActivityParticipant {
  id: string;
  name: string;
  color: string;
  imageUrl?: string;
}

export const ActivityAvatar: React.FC<{
  person: ActivityParticipant;
  className?: string;
  onSelect?: (person: ActivityParticipant) => void;
}> = ({ person, className = '', onSelect }) => {
  useLocale();
  const isLocal = person.id === roomService.roomManager?.getLocalPeerId();
  if (onSelect) {
    return <Tooltip content={person.name}>
      <button type="button" className={`room-app-participant-trigger ${className}`}
        aria-label={person.name} onClick={(event) => { event.stopPropagation(); onSelect(person); }}>
        <ProfileAvatar peerId={person.id} name={person.name} color={person.color} imageUrl={person.imageUrl}
          isLocal={isLocal} className="room-app-participant" />
      </button>
    </Tooltip>;
  }
  return <Tooltip content={person.name}>
    <ProfileAvatar peerId={person.id} name={person.name} color={person.color} imageUrl={person.imageUrl} tabIndex={0}
      isLocal={isLocal} className={`room-app-participant ${className}`} />
  </Tooltip>;
};

export const ActivityParticipants: React.FC<{
  people: ActivityParticipant[];
  className?: string;
  maxVisible?: number;
  ariaLabel?: string;
  onSelectParticipant?: (person: ActivityParticipant) => void;
}> = ({ people, className = '', maxVisible = 5, ariaLabel, onSelectParticipant }) => {
  useLocale();
  const visible = people.slice(0, maxVisible);
  const extra = people.slice(maxVisible);
  return <div className={`room-app-participants ${className}`.trim()}
    aria-label={ariaLabel ?? t("message.e2da9147b952", { v0: people.length })}>
    {visible.map((person) => <ActivityAvatar key={person.id} person={person} onSelect={onSelectParticipant} />)}
    {extra.length > 0 && <Tooltip content={extra.map((person) => person.name).join(', ')}>
      <span className="room-app-participant-extra" tabIndex={0}>+{extra.length}</span>
    </Tooltip>}
  </div>;
};
