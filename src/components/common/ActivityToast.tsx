import React from 'react';
import { ActivityAvatar, type ActivityParticipant } from './ActivityParticipants';

export const ActivityToast: React.FC<{ person: ActivityParticipant; message: string; className?: string }> =
  ({ person, message, className = '' }) => <div className={`activity-toast ${className}`} role="status">
    <ActivityAvatar person={person} className="activity-toast-avatar" />
    <span className="activity-toast-message"><strong>{person.name}</strong> {message}</span>
  </div>;
