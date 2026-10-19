import { useEffect, useState } from 'react';
import { ModalDialog } from '../common/ModalDialog';
import { Select } from '../common/Select';
import { useModal } from '../../hooks/useModal';
import { useLocale } from '../../hooks/useLocale';
import { t, localizeError } from '../../i18n';
import { roomService } from '../../services/room_service';
import { stateStore } from '../../core/state_store';
import { listCameras } from '../../video/camera_devices';

/** Browser permission prompts must start directly from the user's click. */
export function BrowserCaptureModal() {
  useLocale();
  const { closeModal } = useModal();
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const editing = stateStore.editingStreamId ? roomService.localCaptures.get(stateStore.editingStreamId) : undefined;
  const unsupportedEdit = editing?.kind === 'screen';
  const [source, setSource] = useState(editing?.kind === 'camera' ? 'camera' : 'screen');
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
      const screen = source === 'screen';
      // No await before requesting display capture: transient activation is required.
      stream = await (screen ? navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }) :
        navigator.mediaDevices.getUserMedia({ video: source === 'camera' ? true : { deviceId: { exact: source.slice(7) } }, audio: false }));
      const settings = stream.getVideoTracks()[0].getSettings();
      const sourceId = screen ? 'screen:browser' : source === 'camera' ? 'camera:' : source;
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
    <Select aria-label={t('web.source')} value={source} disabled={busy} onValueChange={setSource} options={[
      { value: 'screen', label: t('web.screen'), disabled: !navigator.mediaDevices?.getDisplayMedia },
      { value: 'camera', label: t('message.dafb61aca12d') },
      ...cameras.map((camera, index) => ({ value: `camera:${camera.deviceId}`, label: camera.label || `${t('message.dafb61aca12d')} ${index + 1}` })),
    ]} />
    {error && <p role="alert">{error}</p>}
  </ModalDialog>;
}
