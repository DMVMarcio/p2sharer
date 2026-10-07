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
import { logDiagnostic } from '../core/logger.ts';

export function useScreenPicker(onClose?: () => void, isClosing = false) {
  const editingId = useStore((state) => state.editingStreamId);
  const editing = editingId ? roomService.localCaptures.get(editingId) : undefined;
  const screenEditing = editing?.kind === 'screen' ? editing : undefined;
  const cameraEditing = editing?.kind === 'camera' ? editing : undefined;
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

  const initialRes = screenEditing ?
    screenEditing.resolution.height === 2160 ? '4k' : `${screenEditing.resolution.height}p` :
    localStorage.getItem('p2sharer_default_res') || defaultRes || INITIAL_TRANSMISSION_DEFAULTS.resolution;
  const [screenResolution, setScreenResolution] = useState<string>(initialRes.includes('x')
    ? [360, 480, 720, 1080, 1440].includes(stateStore.parseResolution(initialRes).height)
      ? `${stateStore.parseResolution(initialRes).height}p` : '1080p' : initialRes);
  const initialFps = screenEditing?.fps || Number(localStorage.getItem('p2sharer_default_fps') || defaultFps);
  const [screenFps, setScreenFps] = useState<number>([15, 30, 60, 120].includes(initialFps) ? initialFps : 30);
  const [screenBitrate, setScreenBitrate] = useState<number>(
    screenEditing?.bitrate || parseInt(localStorage.getItem('p2sharer_default_bitrate') || '', 10) ||
      defaultBitrate ||
      stateStore.getDefaultBitrateForResolution(initialRes)
  );
  const [screenQuality, setQuality] = useState<number>(
    screenEditing?.quality || parseInt(localStorage.getItem('p2sharer_default_quality') || (defaultQuality ? defaultQuality.toString() : '90'), 10) || 90
  );
  const [showCursor, setShowCursor] = useState<boolean>(
    screenEditing?.mouse ?? (localStorage.getItem('p2sharer_default_cursor') !== 'false')
  );
  const [cameraResolution, setCameraResolution] = useState(cameraEditing
    ? `${cameraEditing.resolution.width}x${cameraEditing.resolution.height}` : INITIAL_TRANSMISSION_DEFAULTS.resolution);
  const [cameraFps, setCameraFps] = useState(cameraEditing?.fps || INITIAL_TRANSMISSION_DEFAULTS.fps);
  const [cameraBitrate, setCameraBitrate] = useState(cameraEditing?.bitrate ||
    stateStore.getDefaultBitrateForResolution(INITIAL_TRANSMISSION_DEFAULTS.resolution));
  const isCamera = currentTab === 'cameras';
  const resolution = isCamera ? cameraResolution : screenResolution;
  const setResolution = isCamera ? setCameraResolution : setScreenResolution;
  const fps = isCamera ? cameraFps : screenFps;
  const setFps = isCamera ? setCameraFps : setScreenFps;
  const bitrate = isCamera ? cameraBitrate : screenBitrate;
  const setBitrate = isCamera ? setCameraBitrate : setScreenBitrate;
  const quality = isCamera ? cameraEditing?.quality || 90 : screenQuality;

  const receiveModes = useCallback((modes: CameraResolution[]) => {
    setCameraModes(modes);
    setCameraResolution((current) => modes.some((mode) => mode.value === current) ? current :
      modes.find((mode) => mode.height === stateStore.parseResolution(current).height)?.value || modes[0]?.value || current);
  }, []);
  const receiveRates = useCallback((rates: number[]) => {
    setCameraRates(rates);
    setCameraFps((current) => preferredCameraFrameRate(rates, current));
  }, []);
  const selectedMode = cameraModes.find((mode) => mode.value === resolution);
  const resConfig = selectedSourceId.startsWith('camera:') && selectedMode ? selectedMode : stateStore.parseResolution(resolution);
  const preview = useCapturePreview(isLoading ? '' : selectedSourceId, resConfig, fps, showCursor, quality,
    isClosing, receiveModes, receiveRates);

  const handleResolutionChange = useCallback((newRes: string) => {
    setResolution(newRes);
    const autoBitrate = stateStore.getDefaultBitrateForResolution(newRes);
    setBitrate(autoBitrate);
  }, [setResolution, setBitrate]);

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
        listCameras(),
        invoke<ScreenSourcesResponse>('list_screen_sources'),
      ]);
      if (cameraResult.status === 'fulfilled') setCameras(cameraResult.value.filter((device) => device.kind === 'videoinput'));
      else {
        logDiagnostic('WARN', 'capture.sources', 'Camera enumeration failed', { error: cameraResult.reason });
        setError(t("message.b7ee01f4e0b2"));
      }
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
      logDiagnostic('ERROR', 'capture.sources', 'Capture source enumeration failed', { error: err });
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
      if (!chosen.startsWith('camera:')) stateStore.set((s) => {
        s.currentResolution = resConfig;
        s.currentFps = fps;
        s.currentBitrate = bitrate;
        s.currentQuality = quality;
      });
      if (!chosen.startsWith('camera:') && stateStore.rememberTransmissionSettings) {
        try {
          stateStore.saveTransmissionDefaults({ resolution: resConfig.label.toLowerCase(), fps, bitrate, quality, cursor: showCursor });
        } catch (error) {
          console.warn('[Transmission] Could not save the last configuration:', error);
          showToast(t("message.01791eb9ee03"));
        }
      }
      if (onClose) onClose();
    } catch (err) {
      logDiagnostic('ERROR', 'capture.start', 'Transmission confirmation failed', { sourceId: selectedSourceId, editingId, resolution: resConfig, fps, bitrate, error: err });
      setError(t("message.11b6606b6f25", { v0: localizeError(err) }));
      preview.retry();
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
    resConfig.width, resConfig.height, preview.take, preview.retry,
    preview.busy,
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
