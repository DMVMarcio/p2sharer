import { t } from '../i18n/index.ts';
import type { TwitchState } from './types.ts';

export function describeTwitchActivity(
  previous: TwitchState,
  next: TwitchState
): string | null {
  if (previous.channel !== next.channel && next.channel) {
    return t('twitch.activity.channel', { v0: next.channel });
  }
  if (previous.playing !== next.playing) {
    return next.playing ? t('twitch.activity.play') : t('twitch.activity.pause');
  }
  return null;
}
