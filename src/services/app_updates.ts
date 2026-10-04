import { isTauri, invoke } from '@tauri-apps/api/core';
import { Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { AppUpdateController } from '../core/app_updates';
import { roomService } from './room_service';

export const appUpdates = new AppUpdateController({
  check: async (includePrereleases) => {
    if (!isTauri()) throw new Error('Desktop runtime required');
    const metadata = await invoke<ConstructorParameters<typeof Update>[0] | null>('check_app_update', { includePrereleases });
    return metadata ? new Update(metadata) : null;
  },
  prepareInstall: async () => {
    await roomService.leaveRoom();
    await invoke('prepare_app_update');
  },
  restart: relaunch,
  cancelInstall: () => invoke('cancel_app_update'),
});

export function startAutomaticUpdateChecks(): () => void {
  if (!isTauri()) return () => {};
  void appUpdates.check();
  const timer = setInterval(() => void appUpdates.check(), 6 * 60 * 60 * 1000);
  return () => clearInterval(timer);
}
