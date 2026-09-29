import React from 'react';
import { Tooltip } from './Tooltip';

export interface ActivityParticipant {
  id: string;
  name: string;
  color: string;
}

export const ActivityAvatar: React.FC<{ person: ActivityParticipant; className?: string }> =
  ({ person, className = '' }) => <Tooltip content={person.name}>
    <span className={`room-app-participant ${className}`} style={{ backgroundColor: person.color }}
      tabIndex={0} aria-label={person.name}>
      {person.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  </Tooltip>;

export const ActivityParticipants: React.FC<{ people: ActivityParticipant[] }> = ({ people }) =>
  <div className="room-app-participants" aria-label={`${people.length} pessoas nesta atividade`}>
    {people.slice(0, 5).map((person) => <ActivityAvatar key={person.id} person={person} />)}
    {people.length > 5 && <span className="room-app-participant-extra">+{people.length - 5}</span>}
  </div>;
