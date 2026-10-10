import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Upload, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { t } from '../../i18n';
import { profileImages, type ProfileDraft, type ImageCrop } from '../../core/profile_image';
import { contrastingTextColor } from '../../core/accent_color';
import { ModalDialog } from './ModalDialog';
import { PROFILE_CARD_COLORS } from '../../core/profile_card_color';
import { ColorPalette } from './ColorPalette';
import { ColorPicker } from './ColorPicker';
import { TooltipButton } from './TooltipButton';
import { showToast } from '../../hooks/useToast';

function CropPreview({ draft, crop }: { draft: ProfileDraft; crop: ImageCrop }) {
  const side = Math.min(draft.width, draft.height) * crop.size;
  return <img src={draft.preview} alt="" draggable={false} style={{
    width: `${draft.width / side * 100}%`, height: `${draft.height / side * 100}%`,
    left: `${-crop.x * (draft.width - side) / side * 100}%`, top: `${-crop.y * (draft.height - side) / side * 100}%`,
  }} />;
}

function CropDialog({ draft, onApply, onClose }: { draft: ProfileDraft; onApply: (draft: ProfileDraft) => void; onClose: () => void }) {
  const [crop, setCrop] = useState(draft.crop);
  const [drag, setDrag] = useState<{ x: number; y: number; crop: ImageCrop } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const cropFrame = useRef<HTMLDivElement>(null);
  const zoom = (current: ImageCrop, factor: number): ImageCrop => {
    const minimum = Math.min(draft.width, draft.height);
    const size = Math.min(1, Math.max(0.01, current.size * factor));
    const oldSide = minimum * current.size, newSide = minimum * size;
    const position = (axis: 'x' | 'y', dimension: number) => dimension === newSide ? 0.5 :
      Math.min(1, Math.max(0, (current[axis] * (dimension - oldSide) + (oldSide - newSide) / 2) / (dimension - newSide)));
    return { size, x: position('x', draft.width), y: position('y', draft.height) };
  };
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
  }, [draft.width, draft.height]);
  return <ModalDialog title={t('profile.crop')} onClose={onClose} className="profile-crop-dialog"
    footer={close => <>
      <button className="btn btn-secondary" onClick={close}>{t('message.bb9dbb406dcb')}</button>
      <button className="btn btn-primary" onClick={() => { onApply({ ...draft, crop }); close(); }}>{t('message.3a04898a6b8b')}</button>
    </>}>
    <div ref={stage} className={`profile-crop-stage${draft.width > draft.height ? ' is-landscape' : draft.height > draft.width ? ' is-portrait' : ''}`} tabIndex={0} role="group" aria-label={t('profile.crop')}
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
      const side = Math.min(draft.width, draft.height) * drag.crop.size;
      const frameWidth = cropFrame.current?.getBoundingClientRect().width;
      if (!frameWidth) return;
      const scale = frameWidth / side;
      const clamp = (n: number) => Math.min(1, Math.max(0, n));
      setCrop({ ...drag.crop,
        x: draft.width === side ? 0.5 : clamp(drag.crop.x - (event.clientX - drag.x) / scale / (draft.width - side)),
        y: draft.height === side ? 0.5 : clamp(drag.crop.y - (event.clientY - drag.y) / scale / (draft.height - side)),
      });
    }}>
      <div ref={cropFrame} className="profile-crop-frame">
        <CropPreview draft={draft} crop={crop} />
        <span className="profile-crop-circle" />
      </div>
    </div>
  </ModalDialog>;
}

export function ProfileImageEditor({ name, draft, color, remove, onDraft, onColor, onRemove, onBusy, disabled, cardColor, onCardColor, onNameChange }: {
  onNameChange: (name: string) => void;
  cardColor: string | null; onCardColor: (color: string | null) => void;
  name: string; draft: ProfileDraft | null; color: string; remove: boolean; onDraft: (draft: ProfileDraft | null) => void;
  onColor: (color: string) => void; onRemove: (remove: boolean) => void; onBusy: (busy: boolean) => void; disabled: boolean;
}) {
  useSyncExternalStore(profileImages.subscribe, profileImages.snapshot);
  const [selection, setSelection] = useState<ProfileDraft | null>(null);
  const [picking, setPicking] = useState(false);
  const url = remove ? undefined : profileImages.url('local');
  const hasPhoto = Boolean(draft || url);
  const choose = async () => {
    setPicking(true); onBusy(true);
    try {
      const picked = await invoke<Omit<ProfileDraft, 'crop'> | null>('pick_profile_image');
      if (picked) {
        setSelection({ ...picked, crop: { x: 0.5, y: 0.5, size: 1 } });
      }
    } catch { showToast(t('profile.invalid')); }
    finally { setPicking(false); onBusy(false); }
  };
  return <div className="settings-row">
    <span className="settings-label">{t('profile.photo')}</span>
    <div className="profile-editor-identity">
      <div className="profile-editor-avatar-column">
        <div className="profile-editor-photo">
          <TooltipButton tooltip={t(picking ? 'profile.loading' : 'profile.choose')}
            className="btn profile-upload-button" disabled={disabled || picking} aria-busy={picking} onClick={() => void choose()}>
            <span className="profile-avatar profile-editor-preview" style={{ backgroundColor: color,
              color: contrastingTextColor(color) }}>
              {draft ? <CropPreview draft={draft} crop={draft.crop} /> : url ? <img src={url} alt="" draggable={false} /> : name.trim().charAt(0).toUpperCase() || '?'}
              <span className="profile-upload-overlay" aria-hidden="true">{picking ? <span className="loading-spinner" /> : <Upload size={24} />}</span>
            </span>
          </TooltipButton>
          {hasPhoto && <TooltipButton tooltip={t('profile.remove')} className="btn btn-danger profile-remove-button"
            disabled={disabled || picking} onClick={() => {
              if (draft) void invoke('discard_profile_image', { token: draft.token }).catch(() => {});
              onDraft(null); onRemove(true);
            }}><X size={14} aria-hidden="true" /></TooltipButton>}
        </div>
        <ColorPicker label={t(hasPhoto ? 'profile.borderColor' : 'profile.color')} value={color} onChange={onColor} disabled={disabled || picking} />
        {picking && <span className="profile-loading-status" role="status">{t('profile.loading')}</span>}
      </div>
      <div className="profile-editor-details">
        <label className="settings-label" htmlFor="settings-input-username">{t('message.295f254de3a9')}</label>
        <input autoComplete="off" type="text" id="settings-input-username" className="text-input"
          placeholder={t('message.1b92c5e9d144')} maxLength={25} value={name} disabled={disabled || picking}
          onChange={event => onNameChange(event.target.value)} />
        <div className="profile-card-settings">
          <label className="settings-switch-row" htmlFor="profile-card-automatic">
            <span className="settings-switch-title">{t('profile.cardAutomatic')}</span>
            <div className="modern-switch">
              <input autoComplete="off" type="checkbox" id="profile-card-automatic" checked={cardColor === null}
                disabled={disabled || picking} onChange={event => onCardColor(event.target.checked ? null : profileImages.background('local'))} />
              <span className="switch-slider" />
            </div>
          </label>
          {cardColor !== null && <ColorPalette label={t('profile.cardColor')} value={cardColor} onChange={onCardColor}
            disabled={disabled || picking} presets={PROFILE_CARD_COLORS.map(item => ({ value: item.color, color: item.color, label: item.label }))} />}
        </div>
      </div>
    </div>
    {selection && <CropDialog draft={selection} onClose={() => {
      if (selection.token !== draft?.token) void invoke('discard_profile_image', { token: selection.token }).catch(() => {});
      setSelection(null);
    }} onApply={next => {
      if (draft && draft.token !== next.token) void invoke('discard_profile_image', { token: draft.token }).catch(() => {});
      onDraft(next); onRemove(false);
    }} />}
  </div>;
}
