import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React from 'react';
import { Tooltip } from './Tooltip';

export interface ActivityParticipant {
  id: string;
  name: string;
  color: string;
}

export const ActivityAvatar: React.FC<{ person: ActivityParticipant; className?: string }> =
  ({ person, className = '' }) => { useLocale(); return <Tooltip content={person.name}>
    <span className={`room-app-participant ${className}`} style={{ backgroundColor: person.color }}
      tabIndex={0} aria-label={person.name}>
      {person.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  </Tooltip>; };

export const ActivityParticipants: React.FC<{ people: ActivityParticipant[] }> = ({ people }) =>
  { useLocale(); return <div className="room-app-participants" aria-label={t("message.e2da9147b952", { v0: people.length })}>
    {people.slice(0, 5).map((person) => <ActivityAvatar key={person.id} person={person} />)}
    {people.length > 5 && <span className="room-app-participant-extra">+{people.length - 5}</span>}
  </div>; };
