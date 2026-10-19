import { useEffect, useState } from 'react';
import { ModalDialog } from '../common/ModalDialog';
import { Select } from '../common/Select';
import { useModal } from '../../hooks/useModal';
import { useLocale } from '../../hooks/useLocale';
import { t, localizeError } from '../../i18n';
import { roomService } from '../../services/room_service';
import { stateStore } from '../../core/state_store';
import { listCameras } from '../../video/camera_devices';
import { Camera, Monitor, PanelsTopLeft } from 'lucide-react';
import { ChoiceCards } from '../common/ChoiceCards';

/** Browser permission prompts must start directly from the user's click. */
export function BrowserCaptureModal() {
  useLocale();
  const { closeModal } = useModal();
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const editing = stateStore.editingStreamId ? roomService.localCaptures.get(stateStore.editingStreamId) : undefined;
  const unsupportedEdit = editing?.kind === 'screen';
  const [source, setSource] = useState(editing?.kind === 'camera' ? 'camera' : 'screen');
  const [cameraId, setCameraId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void listCameras().then(devices => { if (active) setCameras(devices); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const start = async () => {
    if (busy || unsupportedEdit) return;
    setBusy(true); setError('');
    let stream: MediaStream | undefined;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices) throw new Error(t('web.secureContext'));
      const screen = source !== 'camera';
      const deviceId = cameraId || cameras.find(camera => camera.deviceId && camera.label)?.deviceId || '';
      const resolution = stateStore.currentResolution;
      const video: MediaTrackConstraints = { width: { ideal: resolution?.width ?? 1280 },
        height: { ideal: resolution?.height ?? 720 }, frameRate: { ideal: stateStore.currentFps ?? 30 } };
      // No await before requesting display capture: transient activation is required.
      stream = await (screen ? navigator.mediaDevices.getDisplayMedia({
        video: { ...video, displaySurface: source === 'screen' ? 'monitor' : 'window' } as MediaTrackConstraints, audio: true,
      }) : navigator.mediaDevices.getUserMedia({ video: { ...video, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, audio: false }));
      const settings = stream.getVideoTracks()[0].getSettings();
      const sourceId = screen ? 'screen:browser' : `camera:${settings.deviceId ?? deviceId}`;
      await roomService.startCapture(sourceId, settings.frameRate ?? 30,
        { width: settings.width ?? 1280, height: settings.height ?? 720 }, true, 90,
        screen ? t('web.screen') : t('message.dafb61aca12d'), { sourceId, stream }, stateStore.currentBitrate);
      closeModal();
    } catch (reason) {
      stream?.getTracks().forEach(track => track.stop());
      setError(localizeError(reason));
    } finally { setBusy(false); }
  };
  return <ModalDialog title={t('message.e2deb5c4ba95')} onClose={closeModal} busy={busy}
    footer={<button className="btn btn-primary" disabled={busy || unsupportedEdit} onClick={() => void start()}>{t('web.share')}</button>}>
    <p>{t('web.captureHint')}</p>
    {unsupportedEdit && <p role="status">{t('web.desktopOnly')}</p>}
    <ChoiceCards label={t('web.source')} value={source} disabled={busy || unsupportedEdit} onChange={setSource} options={[
      { value: 'screen', label: t('capture.screen'), icon: <Monitor size={24} />, disabled: !navigator.mediaDevices?.getDisplayMedia },
      { value: 'window', label: t('capture.window'), icon: <PanelsTopLeft size={24} />, disabled: !navigator.mediaDevices?.getDisplayMedia },
      { value: 'camera', label: t('message.dafb61aca12d'), icon: <Camera size={24} />, disabled: !navigator.mediaDevices?.getUserMedia },
    ]} />
    {source === 'camera' && cameras.some(camera => camera.deviceId && camera.label) && <Select aria-label={t('message.dafb61aca12d')}
      value={cameraId || cameras.find(camera => camera.deviceId && camera.label)!.deviceId} disabled={busy}
      onValueChange={setCameraId} options={cameras.filter(camera => camera.deviceId && camera.label)
        .filter((camera, index, all) => all.findIndex(other => other.deviceId === camera.deviceId) === index)
        .map(camera => ({ value: camera.deviceId, label: camera.label }))} />}
    {error && <p role="alert">{error}</p>}
  </ModalDialog>;
}
