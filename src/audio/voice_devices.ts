import { logDiagnostic } from '../core/logger.ts';

export interface AudioDeviceLists {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}

function normalizeAudioDevices(devices: MediaDeviceInfo[], kind: 'audioinput' | 'audiooutput'): MediaDeviceInfo[] {
  const seenIds = new Set<string>();
  return devices.filter((device) => {
    if (device.kind !== kind) return false;
    // Skip Chromium synthetic pseudo-devices when a clean 'default' option is presented separately.
    if (device.deviceId === 'default' || device.deviceId === 'communications') {
      return false;
    }
    if (device.deviceId) {
      if (seenIds.has(device.deviceId)) return false;
      seenIds.add(device.deviceId);
    }
    return true;
  });
}

/** Enumerates audio input and output devices, optionally requesting mic permission once to unlock labels. */
export async function listAudioDevices(requestPermission = false): Promise<AudioDeviceLists> {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!media?.enumerateDevices) {
    return { inputs: [], outputs: [] };
  }
  let allDevices = await media.enumerateDevices();
  const hasLockedLabels = allDevices.some(
    (d) => (d.kind === 'audioinput' || d.kind === 'audiooutput') && (!d.deviceId || !d.label),
  );
  if (requestPermission && hasLockedLabels && media.getUserMedia) {
    let tempStream: MediaStream | null = null;
    try {
      tempStream = await media.getUserMedia({ audio: true, video: false });
      allDevices = await media.enumerateDevices();
    } catch (err) {
      logDiagnostic('WARN', 'voice.devices', 'Could not unlock audio device labels via microphone prompt', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      tempStream?.getTracks().forEach((track) => track.stop());
    }
  }
  return {
    inputs: normalizeAudioDevices(allDevices, 'audioinput'),
    outputs: normalizeAudioDevices(allDevices, 'audiooutput'),
  };
}

export function onAudioDevicesChanged(callback: () => void): () => void {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!media?.addEventListener) return () => {};
  const handler = () => callback();
  media.addEventListener('devicechange', handler);
  return () => {
    media.removeEventListener('devicechange', handler);
  };
}
