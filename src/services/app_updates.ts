import { isTauri, invoke } from '@tauri-apps/api/core';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { AppUpdateController } from '../core/app_updates';
import { roomService } from './room_service';

export const appUpdates = new AppUpdateController({
  check: () => {
    if (!isTauri()) throw new Error('Desktop runtime required');
    return check({ timeout: 15000 });
  },
  prepareInstall: async () => {
    await roomService.leaveRoom();
    await invoke('prepare_app_update');
  },
  restart: relaunch,
});

export function startAutomaticUpdateChecks(): () => void {
  if (!isTauri()) return () => {};
  void appUpdates.check();
  const timer = setInterval(() => void appUpdates.check(), 6 * 60 * 60 * 1000);
  return () => clearInterval(timer);
}
