import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { stateStore } from '../core/state_store';
import { MonitorSource, ScreenSourcesResponse, WindowSource } from '../core/types';
import { useStore } from './useStore';
import { roomService } from '../services/room_service';

export function useScreenPicker(onClose?: () => void) {
  const editingId = useStore((state) => state.editingStreamId);
  const editing = editingId ? roomService.localCaptures.get(editingId) : undefined;
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState('');
  const [monitors, setMonitors] = useState<MonitorSource[]>([]);
  const [windows, setWindows] = useState<WindowSource[]>([]);
  const [currentTab, setCurrentTab] = useState<'screens' | 'windows' | 'cameras'>(editing?.kind === 'camera' ? 'cameras' : editing?.sourceId.startsWith('window:') ? 'windows' : 'screens');
  const [selectedSourceId, setSelectedSourceId] = useState<string>(editing?.sourceId || 'screen:0');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isStarting, setIsStarting] = useState<boolean>(false);

  const defaultRes = useStore((s) => s.currentResolution.label.toLowerCase());
  const defaultFps = useStore((s) => s.currentFps);
  const defaultBitrate = useStore((s) => s.currentBitrate);
  const defaultQuality = useStore((s) => s.currentQuality);

  const initialRes = editing ? editing.resolution.height === 2160 ? '4k' : `${editing.resolution.height}p` : localStorage.getItem('p2sharer_default_res') || defaultRes || '1080p';
  const [resolution, setResolution] = useState<string>(initialRes);
  const [fps, setFps] = useState<number>(
    editing?.fps || parseInt(localStorage.getItem('p2sharer_default_fps') || defaultFps.toString(), 10) || 60
  );
  const [bitrate, setBitrate] = useState<number>(
    editing?.bitrate || parseInt(localStorage.getItem('p2sharer_default_bitrate') || '', 10) ||
      defaultBitrate ||
      stateStore.getDefaultBitrateForResolution(initialRes)
  );
  const [quality, setQuality] = useState<number>(
    editing?.quality || parseInt(localStorage.getItem('p2sharer_default_quality') || (defaultQuality ? defaultQuality.toString() : '90'), 10) || 90
  );
  const [showCursor, setShowCursor] = useState<boolean>(
    editing?.mouse ?? (localStorage.getItem('p2sharer_default_cursor') !== 'false')
  );

  const handleResolutionChange = useCallback((newRes: string) => {
    setResolution(newRes);
    const autoBitrate = stateStore.getDefaultBitrateForResolution(newRes);
    setBitrate(autoBitrate);
  }, []);

  const handleTabChange = useCallback((tab: 'screens' | 'windows' | 'cameras') => {
    setCurrentTab(tab);
    if (tab === 'cameras') {
      setSelectedSourceId(cameras[0] ? `camera:${cameras[0].deviceId}` : '');
      return;
    }
    if (tab === 'screens' && monitors.length > 0) {
      if (!selectedSourceId || !selectedSourceId.startsWith('screen:')) {
        setSelectedSourceId(monitors[0].id);
      }
    } else if (tab === 'windows' && windows.length > 0) {
      if (!selectedSourceId || !selectedSourceId.startsWith('window:')) {
        setSelectedSourceId(windows[0].id);
      }
    }
  }, [monitors, windows, cameras, selectedSourceId]);

  const loadSources = useCallback(async () => {
    setIsLoading(true);
    try {
      setError('');
      const [cameraResult, screenResult] = await Promise.allSettled([
        navigator.mediaDevices?.enumerateDevices() || Promise.resolve([] as MediaDeviceInfo[]),
        invoke<ScreenSourcesResponse>('list_screen_sources'),
      ]);
      if (cameraResult.status === 'fulfilled') setCameras(cameraResult.value.filter((device) => device.kind === 'videoinput'));
      else setError('Não foi possível listar as câmeras. Verifique as permissões de câmera do Windows.');
      if (screenResult.status === 'rejected') throw screenResult.reason;
      const resp = screenResult.value;
      const monList = resp.monitors || [];
      const winList = resp.windows || [];
      setMonitors(monList);
      setWindows(winList);

      if (editing) { setSelectedSourceId(editing.sourceId); } else if (monList.length > 0) {
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
      setError(`Não foi possível listar as fontes: ${err}`);
    } finally {
      setIsLoading(false);
    }
  }, [editingId]);

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
      const label = monitors.find((source) => source.id === chosen)?.name || windows.find((source) => source.id === chosen)?.title ||
        cameras.find((source) => `camera:${source.deviceId}` === chosen)?.label;
      await roomService.startCapture(chosen, fps, { width: resConfig.width, height: resConfig.height }, showCursor, quality, label);
      if (onClose) onClose();
    } catch (err) {
      setError(`Não foi possível aplicar a transmissão: ${err}`);
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
    selectedSourceId,
    currentTab,
    windows,
    monitors,
    cameras,
    showCursor,
    onClose,
  ]);

  return {
    cameras,
    editingId,
    editingKind: editing?.kind,
    error,
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
    loadSources,
    confirmPicker,
  };
}
