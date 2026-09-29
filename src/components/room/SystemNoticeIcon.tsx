import React from 'react';
import { AppWindow, Info, LogIn, LogOut, MonitorPlay, MonitorOff, SquareX } from 'lucide-react';
import type { ChatMessage } from '../../core/types.ts';

interface SystemNoticeIconProps {
  type: NonNullable<ChatMessage['systemType']>;
}

export const SystemNoticeIcon: React.FC<SystemNoticeIconProps> = ({ type }) => {
  const Icon = type === 'join' ? LogIn : type === 'leave' ? LogOut
    : type === 'stream-start' ? MonitorPlay : type === 'stream-stop' ? MonitorOff
      : type === 'app-start' ? AppWindow : type === 'app-stop' ? SquareX : Info;
  return <Icon className="chat-sys-icon" size={14} strokeWidth={1.8} aria-hidden="true" />;
};
