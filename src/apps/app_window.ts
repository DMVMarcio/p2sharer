import { emitTo } from '@tauri-apps/api/event';
import type { RoomAppInstance } from './types';

export const appWindowPeerId = (id: string) => `app-${id}`;
export const appWindowLabel = (id: string) => `pip-${appWindowPeerId(id)}`;
export const appWindowEvent = (id: string) => `room-app-window-${id}`;
export type AppWindowMessage =
  | { type: 'ready' }
  | { type: 'update'; payload: unknown }
  | { type: 'state'; instance: RoomAppInstance; actor: string; participants: string[];
      snapshot: unknown; username: string; receivedAt?: number }
  | { type: 'restore' };

export function sendAppWindow(id: string, target: 'main' | 'external', message: AppWindowMessage) {
  return emitTo(target === 'main' ? 'main' : appWindowLabel(id), appWindowEvent(id), message);
}
