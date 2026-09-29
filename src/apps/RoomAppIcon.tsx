import React from 'react';
import { AppWindow } from 'lucide-react';
import { getRoomApp } from './registry';

interface Props {
  kind: string;
  size: number;
  strokeWidth?: number;
}

export const RoomAppIcon: React.FC<Props> = ({ kind, size, strokeWidth = 1.8 }) => {
  const definition = getRoomApp(kind);
  const Icon = definition?.icon || AppWindow;
  return definition?.iconStyle === 'filled'
    ? <Icon size={size} aria-hidden={true} />
    : <Icon size={size} strokeWidth={strokeWidth} aria-hidden={true} />;
};
