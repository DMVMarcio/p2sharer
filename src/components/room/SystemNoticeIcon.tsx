import React from 'react';
import { Info, LogIn, LogOut } from 'lucide-react';
import type { ChatMessage } from '../../core/types.ts';

interface SystemNoticeIconProps {
  type: NonNullable<ChatMessage['systemType']>;
}

export const SystemNoticeIcon: React.FC<SystemNoticeIconProps> = ({ type }) => {
  const Icon = type === 'join' ? LogIn : type === 'leave' ? LogOut : Info;
  return <Icon className="chat-sys-icon" size={12} strokeWidth={1.8} aria-hidden="true" />;
};
