import { isShortRoomCode } from './room_invite.ts';

export function webRoomPath(code?: string | null): string {
  return code && isShortRoomCode(code) ? `/app/${code}` : '/app';
}

export function roomCodeFromPath(path: string): string | null {
  const code = /^\/app\/([0-9a-f]{32})\/?$/.exec(path)?.[1];
  return code ?? null;
}

export function extractWebRoomCode(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? roomCodeFromPath(url.pathname) : null;
  } catch { return null; }
}
