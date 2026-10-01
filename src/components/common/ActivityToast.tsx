import React from 'react';
import { ActivityAvatar, type ActivityParticipant } from './ActivityParticipants';

export const ActivityToast: React.FC<{ person?: ActivityParticipant; icon?: React.ReactNode; message: string; className?: string }> =
  ({ person, icon, message, className = '' }) => <div className={`activity-toast ${className}`} role="status">
    {person ? <ActivityAvatar person={person} className="activity-toast-avatar" />
      : icon && <span className="activity-toast-icon" aria-hidden="true">{icon}</span>}
    <span className="activity-toast-message">{person && <><strong>{person.name}</strong> </>}{message}</span>
  </div>;
