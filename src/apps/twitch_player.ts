import { t } from '../i18n/index.ts';

export interface TwitchPlayerInstance {
  play(): void;
  pause(): void;
  setChannel(channel: string): void;
  getChannel(): string;
  isPaused(): boolean;
  setMuted(muted: boolean): void;
  getMuted(): boolean;
  setVolume(volume: number): void;
  getVolume(): number;
  getQuality(): string;
  setQuality(quality: string): void;
  getQualities(): Array<{ name: string; group: string }>;
  addEventListener(event: string, handler: () => void): void;
  removeEventListener(event: string, handler: () => void): void;
}

export interface TwitchPlayerOptions {
  channel: string;
  autoplay?: boolean;
  muted?: boolean;
  onReady?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  onOnline?: () => void;
  onOffline?: () => void;
}

declare global {
  interface Window {
    Twitch?: {
      Player: {
        new (element: HTMLElement | string, options: Record<string, unknown>): TwitchPlayerInstance;
        READY: string;
        PLAY: string;
        PAUSE: string;
        ONLINE: string;
        OFFLINE: string;
      };
    };
  }
}

let scriptLoading: Promise<void> | null = null;

export function loadTwitchPlayerScript(): Promise<void> {
  if (window.Twitch?.Player) return Promise.resolve();
  if (!scriptLoading) {
    scriptLoading = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://player.twitch.tv/js/embed/v1.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scriptLoading = null;
        reject(new Error(t('twitch.scriptError')));
      };
      document.head.appendChild(script);
    });
  }
  return scriptLoading;
}

export function getTwitchParentHost(): string {
  return window.location.hostname || 'localhost';
}

export function parseTwitchChannel(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]{3,25})(?:[/?#].*)?$/i);
  if (urlMatch) return urlMatch[1].toLowerCase();
  const directMatch = trimmed.replace(/^@/, '').match(/^[a-zA-Z0-9_]{3,25}$/);
  if (directMatch) return directMatch[0].toLowerCase();
  return null;
}

export function createTwitchPlayer(
  element: HTMLElement,
  options: TwitchPlayerOptions
): TwitchPlayerInstance {
  if (!window.Twitch?.Player) throw new Error(t('twitch.scriptError'));

  const parent = getTwitchParentHost();
  const player = new window.Twitch.Player(element, {
    channel: options.channel,
    width: '100%',
    height: '100%',
    parent: [parent],
    autoplay: options.autoplay ?? true,
    muted: options.muted ?? false,
  });

  const { READY, PLAY, PAUSE, ONLINE, OFFLINE } = window.Twitch.Player;

  if (options.onReady) player.addEventListener(READY, options.onReady);
  if (options.onPlay) player.addEventListener(PLAY, options.onPlay);
  if (options.onPause) player.addEventListener(PAUSE, options.onPause);
  if (options.onOnline) player.addEventListener(ONLINE, options.onOnline);
  if (options.onOffline) player.addEventListener(OFFLINE, options.onOffline);

  return player;
}
