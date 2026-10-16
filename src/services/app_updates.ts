import { isTauri, invoke, Channel, Resource } from '@tauri-apps/api/core';
import { Update } from '@tauri-apps/plugin-updater';
import type { DownloadEvent } from '@tauri-apps/plugin-updater';
import { AppUpdateController } from '../core/app_updates';
import { roomService } from './room_service';

class PortableUpdate extends Update {
  private payload?: Resource;

  override async download(onEvent?: (event: DownloadEvent) => void): Promise<void> {
    const channel = new Channel<DownloadEvent>();
    if (onEvent) channel.onmessage = onEvent;
    await this.payload?.close();
    this.payload = undefined;
    this.payload = new Resource(await invoke<number>('download_portable_update', { rid: this.rid, onEvent: channel }));
  }

  override async install(): Promise<void> {
    if (!this.payload) throw new Error('Download the portable update before installing');
    await invoke('install_portable_update', { bytesRid: this.payload.rid });
  }

  override async close(): Promise<void> {
    await this.payload?.close();
    await super.close();
  }
}

export const appUpdates = new AppUpdateController({
  check: async (includePrereleases) => {
    if (!isTauri()) throw new Error('Desktop runtime required');
    const metadata = await invoke<(ConstructorParameters<typeof Update>[0] & { portable: boolean }) | null>('check_app_update', { includePrereleases });
    return metadata ? (metadata.portable ? new PortableUpdate(metadata) : new Update(metadata)) : null;
  },
  prepareInstall: async () => {
    await roomService.leaveRoom();
    await invoke('prepare_app_update');
  },
  restart: () => invoke('restart_after_update'),
  cancelInstall: () => invoke('cancel_app_update'),
});

export function startAutomaticUpdateChecks(): () => void {
  if (!isTauri()) return () => {};
  return appUpdates.startAutomaticChecks();
}
