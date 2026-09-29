import type { YouTubeState } from './types.ts';

export const youtubePipPeerId = (instanceId: string): string => `youtube-${instanceId}`;
export const youtubePipEvent = (instanceId: string): string => `youtube-pip-${instanceId}`;

export type YouTubePipCommand =
  | { action: 'toggle' | 'previous' | 'next' }
  | { action: 'seek'; position: number };

export interface YouTubePipLocalSettings {
  volume: number;
  muted: boolean;
  captions: boolean;
}

export type YouTubePipMessage =
  | { source: 'pip'; type: 'ready' }
  | { source: 'pip'; type: 'progress'; videoId: string; position: number; duration: number; playing: boolean }
  | { source: 'pip'; type: 'ended'; videoId: string }
  | { source: 'pip'; type: 'command'; command: YouTubePipCommand }
  | { source: 'pip'; type: 'settings'; settings: YouTubePipLocalSettings }
  | { source: 'main'; type: 'settings'; settings: YouTubePipLocalSettings }
  | { source: 'main'; type: 'state'; state: YouTubeState; receivedAt: number; sequence: number;
    settings: YouTubePipLocalSettings };

export function validYouTubePipSettings(value: unknown): value is YouTubePipLocalSettings {
  if (!value || typeof value !== 'object') return false;
  const settings = value as YouTubePipLocalSettings;
  return Number.isFinite(settings.volume) && settings.volume >= 0 && settings.volume <= 100 &&
    typeof settings.muted === 'boolean' && typeof settings.captions === 'boolean';
}

export function validYouTubePipCommand(value: unknown): value is YouTubePipCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as YouTubePipCommand;
  if (command.action === 'toggle' || command.action === 'previous' || command.action === 'next') return true;
  return command.action === 'seek' && Number.isFinite(command.position) &&
    command.position >= 0 && command.position < 86_400;
}
