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
  const [isStarting, setIsStarting] = useState<boolean>(false);

  const defaultRes = useStore((s) => s.currentResolution.label.toLowerCase());
  const defaultFps = useStore((s) => s.currentFps);
  const defaultBitrate = useStore((s) => s.currentBitrate);
  const defaultQuality = useStore((s) => s.currentQuality);

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
  const [quality, setQuality] = useState<number>(
    parseInt(localStorage.getItem('p2sharer_default_quality') || (defaultQuality ? defaultQuality.toString() : '90'), 10) || 90
  );
  const [showCursor, setShowCursor] = useState<boolean>(
    localStorage.getItem('p2sharer_default_cursor') !== 'false'
  );
  const [captureMode, setCaptureMode] = useState<'wgc' | 'compatibility'>(
    localStorage.getItem('p2sharer_capture_mode') === 'compatibility' ? 'compatibility' : 'wgc'
  );

  const handleResolutionChange = useCallback((newRes: string) => {
    setResolution(newRes);
    const autoBitrate = stateStore.getDefaultBitrateForResolution(newRes);
    setBitrate(autoBitrate);
  }, []);

  const handleTabChange = useCallback((tab: 'screens' | 'windows') => {
    setCurrentTab(tab);
    if (tab === 'screens' && monitors.length > 0) {
      if (!selectedSourceId || !selectedSourceId.startsWith('screen:')) {
        setSelectedSourceId(monitors[0].id);
      }
    } else if (tab === 'windows' && windows.length > 0) {
      if (!selectedSourceId || !selectedSourceId.startsWith('window:')) {
        setSelectedSourceId(windows[0].id);
      }
    }
  }, [monitors, windows, selectedSourceId]);

  const loadSources = useCallback(async () => {
    setIsLoading(true);
    try {
      const resp = await invoke<ScreenSourcesResponse>('list_screen_sources');
      const monList = resp.monitors || [];
      const winList = resp.windows || [];
      setMonitors(monList);
      setWindows(winList);

      if (monList.length > 0) {
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('p2sharer_last_monitor_count', monList.length.toString());
          }
        } catch {}
        setSelectedSourceId(monList[0].id);
      } else if (winList.length > 0) {
        setCurrentTab('windows');
        setSelectedSourceId(winList[0].id);
      }
    } catch (err) {
      console.error('Failed to list screen sources:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const confirmPicker = useCallback(async () => {
    if (isLoading || isStarting) return;
    setIsStarting(true);
    try {
      const resConfig = stateStore.parseResolution(resolution);
      stateStore.set((s) => {
        s.currentResolution = resConfig;
        s.currentFps = fps;
        s.currentBitrate = bitrate;
        s.currentQuality = quality;
      });

      const fallbackId = currentTab === 'windows'
        ? (windows[0]?.id || 'window:0')
        : (monitors[0]?.id || 'screen:0');
      const chosen = selectedSourceId || fallbackId;
      localStorage.setItem('p2sharer_capture_mode', captureMode);

      if (onClose) onClose();
      await startCapture(chosen, fps, { width: resConfig.width, height: resConfig.height }, showCursor, quality, captureMode);
    } catch (err) {
      console.error('Failed to start capture:', err);
    } finally {
      setIsStarting(false);
    }
  }, [
    isLoading,
    isStarting,
    resolution,
    fps,
    bitrate,
    quality,
    captureMode,
    selectedSourceId,
    currentTab,
    windows,
    monitors,
    showCursor,
    onClose,
    startCapture,
  ]);

  return {
    monitors,
    windows,
    currentTab,
    setCurrentTab: handleTabChange,
    selectedSourceId,
    setSelectedSourceId,
    isLoading,
    isStarting,
    resolution,
    setResolution: handleResolutionChange,
    fps,
    setFps,
    bitrate,
    setBitrate,
    quality,
    setQuality,
    showCursor,
    setShowCursor,
    captureMode,
    setCaptureMode,
    loadSources,
    confirmPicker,
  };
}
