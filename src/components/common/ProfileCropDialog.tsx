import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import type { ProfileDraft, ImageCrop } from '../../core/profile_image';
import { cropDimensions, zoomCrop } from '../../core/profile_crop';
import { ModalDialog } from './ModalDialog';

export function CropPreview({ draft, crop, aspect = 1 }: { draft: ProfileDraft; crop: ImageCrop; aspect?: number }) {
  const dimensions = cropDimensions(draft.width, draft.height, crop, aspect);
  return <img src={draft.preview} alt="" draggable={false} style={{
    width: `${draft.width / dimensions.width * 100}%`, height: `${draft.height / dimensions.height * 100}%`,
    left: `${-crop.x * (draft.width - dimensions.width) / dimensions.width * 100}%`, top: `${-crop.y * (draft.height - dimensions.height) / dimensions.height * 100}%`,
  }} />;
}

export function ProfileCropDialog({ draft, onApply, onClose, aspect = 1, label = t('profile.crop') }: { draft: ProfileDraft; onApply: (draft: ProfileDraft) => void; onClose: () => void; aspect?: number; label?: string }) {
  const [crop, setCrop] = useState(draft.crop);
  const [drag, setDrag] = useState<{ x: number; y: number; crop: ImageCrop } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const cropFrame = useRef<HTMLDivElement>(null);
  const zoom = (current: ImageCrop, factor: number) => zoomCrop(draft.width, draft.height, current, factor, aspect);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      setCrop(current => zoom(current, Math.exp(Math.min(300, Math.max(-300, delta)) * 0.002)));
      setDrag(null);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [draft.width, draft.height, aspect]);
  return <ModalDialog title={label} onClose={onClose} className={`profile-crop-dialog${aspect !== 1 ? ' profile-banner-crop-dialog' : ''}`}
    footer={close => <>
      <button className="btn btn-secondary" onClick={close}>{t('message.bb9dbb406dcb')}</button>
      <button className="btn btn-primary" onClick={() => { onApply({ ...draft, crop }); close(); }}>{t('message.3a04898a6b8b')}</button>
    </>}>
    <div ref={stage} className={`profile-crop-stage${aspect !== 1 ? ' is-banner' : ''}${draft.width > draft.height ? ' is-landscape' : draft.height > draft.width ? ' is-portrait' : ''}`} tabIndex={0} role="group" aria-label={label}
      onKeyDown={event => {
        if (['+', '=', '-', '_'].includes(event.key)) {
          event.preventDefault(); setCrop(current => zoom(current, event.key === '+' || event.key === '=' ? 0.9 : 1 / 0.9));
        } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          setCrop(current => ({ ...current,
            x: Math.min(1, Math.max(0, current.x + (event.key === 'ArrowLeft' ? -0.02 : event.key === 'ArrowRight' ? 0.02 : 0))),
            y: Math.min(1, Math.max(0, current.y + (event.key === 'ArrowUp' ? -0.02 : event.key === 'ArrowDown' ? 0.02 : 0))),
          }));
        }
      }} onPointerDown={event => {
      event.currentTarget.setPointerCapture(event.pointerId); setDrag({ x: event.clientX, y: event.clientY, crop });
    }} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)} onPointerMove={event => {
      if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const dimensions = cropDimensions(draft.width, draft.height, drag.crop, aspect);
      const frameWidth = cropFrame.current?.getBoundingClientRect().width;
      if (!frameWidth) return;
      const scale = frameWidth / dimensions.width;
      const clamp = (n: number) => Math.min(1, Math.max(0, n));
      setCrop({ ...drag.crop,
        x: draft.width === dimensions.width ? 0.5 : clamp(drag.crop.x - (event.clientX - drag.x) / scale / (draft.width - dimensions.width)),
        y: draft.height === dimensions.height ? 0.5 : clamp(drag.crop.y - (event.clientY - drag.y) / scale / (draft.height - dimensions.height)),
      });
    }}>
      <div ref={cropFrame} className="profile-crop-frame" style={{ aspectRatio: aspect }}>
        <CropPreview draft={draft} crop={crop} aspect={aspect} />
        <span className={`profile-crop-circle${aspect !== 1 ? ' is-banner' : ''}`} />
      </div>
    </div>
  </ModalDialog>;
}
