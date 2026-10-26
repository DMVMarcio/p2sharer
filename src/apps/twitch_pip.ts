import type { TwitchState } from './types.ts';

export const twitchPipPeerId = (instanceId: string): string => `twitch-${instanceId}`;
export const twitchPipEvent = (instanceId: string): string => `twitch-pip-${instanceId}`;

export type TwitchPipCommand =
  | { action: 'toggle' };

export interface TwitchPipLocalSettings {
  volume: number;
  muted: boolean;
}

export type TwitchPipMessage =
  | { source: 'pip'; type: 'ready' }
  | { source: 'pip'; type: 'command'; command: TwitchPipCommand }
  | { source: 'pip'; type: 'settings'; settings: TwitchPipLocalSettings }
  | { source: 'main'; type: 'settings'; settings: TwitchPipLocalSettings }
  | { source: 'main'; type: 'state'; state: TwitchState; settings: TwitchPipLocalSettings };

export function validTwitchPipSettings(value: unknown): value is TwitchPipLocalSettings {
  if (!value || typeof value !== 'object') return false;
  const settings = value as TwitchPipLocalSettings;
  return Number.isFinite(settings.volume) && settings.volume >= 0 && settings.volume <= 100 &&
    typeof settings.muted === 'boolean';
}

export function validTwitchPipCommand(value: unknown): value is TwitchPipCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as TwitchPipCommand;
  return command.action === 'toggle';
}
