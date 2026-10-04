import { localizeError, t } from '../i18n/index.ts';
import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { INITIAL_TRANSMISSION_DEFAULTS, stateStore } from '../core/state_store';
import { MonitorSource, ScreenSourcesResponse, WindowSource } from '../core/types';
import { useStore } from './useStore';
import { roomService } from '../services/room_service';
import { listCameras, preferredCameraFrameRate, type CameraResolution } from '../video/camera_devices';
import { useCapturePreview } from './useCapturePreview';
import { showToast } from './useToast';

export function useScreenPicker(onClose?: () => void, isClosing = false) {
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
  const [cameraModes, setCameraModes] = useState<CameraResolution[]>([]);
  const [cameraRates, setCameraRates] = useState<number[]>([]);

  const defaultRes = useStore((s) => s.currentResolution.label.toLowerCase());
  const defaultFps = useStore((s) => s.currentFps);
  const defaultBitrate = useStore((s) => s.currentBitrate);
  const defaultQuality = useStore((s) => s.currentQuality);

  const initialRes = editing ? editing.kind === 'camera' ? `${editing.resolution.width}x${editing.resolution.height}` :
    editing.resolution.height === 2160 ? '4k' : `${editing.resolution.height}p` :
    localStorage.getItem('p2sharer_default_res') || defaultRes || INITIAL_TRANSMISSION_DEFAULTS.resolution;
  const [resolution, setResolution] = useState<string>(initialRes.includes('x') && editing?.kind !== 'camera'
    ? [360, 480, 720, 1080, 1440].includes(stateStore.parseResolution(initialRes).height)
      ? `${stateStore.parseResolution(initialRes).height}p` : '1080p' : initialRes);
  const initialFps = editing?.fps || Number(localStorage.getItem('p2sharer_default_fps') || defaultFps);
  const [fps, setFps] = useState<number>(editing?.kind === 'camera' || [15, 30, 60, 120].includes(initialFps) ? initialFps : 30);
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

  const receiveModes = useCallback((modes: CameraResolution[]) => {
    setCameraModes(modes);
    setResolution((current) => modes.some((mode) => mode.value === current) ? current :
      modes.find((mode) => mode.height === stateStore.parseResolution(current).height)?.value || modes[0]?.value || current);
  }, []);
  const receiveRates = useCallback((rates: number[]) => {
    setCameraRates(rates);
    setFps((current) => preferredCameraFrameRate(rates, current));
  }, []);
  const selectedMode = cameraModes.find((mode) => mode.value === resolution);
  const resConfig = selectedSourceId.startsWith('camera:') && selectedMode ? selectedMode : stateStore.parseResolution(resolution);
  const preview = useCapturePreview(isLoading ? '' : selectedSourceId, resConfig, fps, showCursor, quality,
    isClosing, receiveModes, receiveRates);

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
    setResolution((current) => {
      if (!current.includes('x')) return current;
      const height = stateStore.parseResolution(current).height;
      return height === 2160 ? '4k' : [360, 480, 720, 1080, 1440].includes(height) ? `${height}p` : '1080p';
    });
    if (!([15, 30, 60, 120].includes(fps))) setFps(30);
    if (tab === 'screens' && monitors.length > 0) {
      if (!selectedSourceId || !selectedSourceId.startsWith('screen:')) {
        setSelectedSourceId(monitors[0].id);
      }
    } else if (tab === 'windows' && windows.length > 0) {
      if (!selectedSourceId || !selectedSourceId.startsWith('window:')) {
        setSelectedSourceId(windows[0].id);
      }
    }
  }, [monitors, windows, cameras, selectedSourceId, fps]);

  const loadSources = useCallback(async () => {
    setIsLoading(true);
    try {
      setError('');
      const [cameraResult, screenResult] = await Promise.allSettled([
        listCameras(),
        invoke<ScreenSourcesResponse>('list_screen_sources'),
      ]);
      if (cameraResult.status === 'fulfilled') setCameras(cameraResult.value.filter((device) => device.kind === 'videoinput'));
      else setError(t("message.b7ee01f4e0b2"));
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
      setError(t("message.f3ec8f258239", { v0: localizeError(err) }));
    } finally {
      setIsLoading(false);
    }
  }, [editingId]);

  const confirmPicker = useCallback(async () => {
    if (isLoading || isStarting || preview.busy) return;
    setIsStarting(true);
    try {
      const fallbackId = currentTab === 'windows'
        ? (windows[0]?.id || 'window:0')
        : (monitors[0]?.id || 'screen:0');
      const chosen = selectedSourceId || fallbackId;
      const label = monitors.find((source) => source.id === chosen)?.name || windows.find((source) => source.id === chosen)?.title ||
        cameras.find((source) => `camera:${source.deviceId}` === chosen)?.label;
      const prepared = await preview.take();
      await roomService.startCapture(chosen, fps, { width: resConfig.width, height: resConfig.height }, showCursor, quality, label, prepared, bitrate);
      stateStore.set((s) => {
        s.currentResolution = resConfig;
        s.currentFps = fps;
        s.currentBitrate = bitrate;
        s.currentQuality = quality;
      });
      if (stateStore.rememberTransmissionSettings) {
        try {
          stateStore.saveTransmissionDefaults({ resolution: resConfig.label.toLowerCase(), fps, bitrate, quality, cursor: showCursor });
        } catch (error) {
          console.warn('[Transmission] Could not save the last configuration:', error);
          showToast(t("message.01791eb9ee03"));
        }
      }
      if (onClose) onClose();
    } catch (err) {
      setError(t("message.11b6606b6f25", { v0: localizeError(err) }));
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
    resConfig.width, resConfig.height, preview.take,
  ]);

  return {
    cameras,
    cameraModes,
    cameraRates,
    preview,
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
