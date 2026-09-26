import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { stateStore } from '../core/state_store';
import { MonitorSource, ScreenSourcesResponse, WindowSource } from '../core/types';
import { useStore } from './useStore';
import { useScreenCapture } from './useScreenCapture';

export function useScreenPicker(onClose?: () => void) {
  const { startCapture } = useScreenCapture();
  const [monitors, setMonitors] = useState<MonitorSource[]>([]);
  const [windows, setWindows] = useState<WindowSource[]>([]);
  const [currentTab, setCurrentTab] = useState<'screens' | 'windows'>('screens');
  const [selectedSourceId, setSelectedSourceId] = useState<string>('screen:0');
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const defaultRes = useStore((s) => s.currentResolution.label.toLowerCase());
  const defaultFps = useStore((s) => s.currentFps);
  const defaultBitrate = useStore((s) => s.currentBitrate);

  const initialRes = localStorage.getItem('p2sharer_default_res') || defaultRes || '1080p';
  const [resolution, setResolution] = useState<string>(initialRes);
  const [fps, setFps] = useState<number>(
    parseInt(localStorage.getItem('p2sharer_default_fps') || defaultFps.toString(), 10) || 60
  );
  const [bitrate, setBitrate] = useState<number>(
    parseInt(localStorage.getItem('p2sharer_default_bitrate') || '', 10) ||
      defaultBitrate ||
      stateStore.getDefaultBitrateForResolution(initialRes)
  );
  const [showCursor, setShowCursor] = useState<boolean>(
    localStorage.getItem('p2sharer_default_cursor') !== 'false'
  );

  const handleResolutionChange = useCallback((newRes: string) => {
    setResolution(newRes);
    const autoBitrate = stateStore.getDefaultBitrateForResolution(newRes);
    setBitrate(autoBitrate);
  }, []);

  const loadSources = useCallback(async () => {
    setIsLoading(true);
    try {
      const resp = await invoke<ScreenSourcesResponse>('list_screen_sources');
      const monList = resp.monitors || [];
      const winList = resp.windows || [];
      setMonitors(monList);
      setWindows(winList);

      if (monList.length > 0) {
        setSelectedSourceId(monList[0].id);
      } else if (winList.length > 0) {
        setSelectedSourceId(winList[0].id);
      }
    } catch (err) {
      console.error('Failed to list screen sources:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const confirmPicker = useCallback(async () => {
    if (isLoading) return;
    const resConfig = stateStore.parseResolution(resolution);
    stateStore.set((s) => {
      s.currentResolution = resConfig;
      s.currentFps = fps;
      s.currentBitrate = bitrate;
    });

    const chosen = selectedSourceId || (currentTab === 'windows' ? 'window:0' : 'screen:0');
    if (onClose) onClose();
    await startCapture(chosen, fps, { width: resConfig.width, height: resConfig.height }, showCursor);
  }, [resolution, fps, bitrate, selectedSourceId, currentTab, showCursor, onClose, startCapture]);

  return {
    monitors,
    windows,
    currentTab,
    setCurrentTab,
    selectedSourceId,
    setSelectedSourceId,
    isLoading,
    resolution,
    setResolution: handleResolutionChange,
    fps,
    setFps,
    bitrate,
    setBitrate,
    showCursor,
    setShowCursor,
    loadSources,
    confirmPicker,
  };
}
