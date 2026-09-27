import { useCallback } from 'react';
import { roomService } from '../services/room_service';
import { useStore } from './useStore';

export function useScreenCapture() {
  const isSharingScreen = useStore((s) => s.isSharingScreen);
  const currentFps = useStore((s) => s.currentFps);
  const currentBitrate = useStore((s) => s.currentBitrate);
  const currentResolution = useStore((s) => s.currentResolution);

  const startCapture = useCallback(
    async (
      sourceId: string,
      fps: number,
      res: { width: number; height: number },
      mouse: boolean,
      quality?: number
    ) => {
      await roomService.startCapture(sourceId, fps, res, mouse, quality);
    },
    []
  );

  const stopCapture = useCallback(() => {
    roomService.stopScreenSharing();
  }, []);

  return {
    isSharingScreen,
    currentFps,
    currentBitrate,
    currentResolution,
    startCapture,
    stopCapture,
  };
}
