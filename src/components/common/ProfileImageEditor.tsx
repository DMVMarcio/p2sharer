import { useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { t } from '../../i18n';
import { profileImages, type ProfileDraft, type ImageCrop } from '../../core/profile_image';
import { customAccentTokens } from '../../core/accent_color';
import { ModalDialog } from './ModalDialog';
import { ColorPicker } from './ColorPicker';
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
  return <ModalDialog title={t('profile.crop')} onClose={onClose} className="profile-crop-dialog"
    footer={close => <>
      <button className="btn btn-secondary" onClick={close}>{t('message.bb9dbb406dcb')}</button>
      <button className="btn btn-primary" onClick={() => { onApply({ ...draft, crop }); close(); }}>{t('message.3a04898a6b8b')}</button>
    </>}>
    <p className="field-info-text">{t('profile.cropHint')}</p>
    <div className="profile-crop-stage" onPointerDown={event => {
      event.currentTarget.setPointerCapture(event.pointerId); setDrag({ x: event.clientX, y: event.clientY, crop });
    }} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)} onPointerMove={event => {
      if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const side = Math.min(draft.width, draft.height) * drag.crop.size;
      const scale = event.currentTarget.getBoundingClientRect().width / side;
      const clamp = (n: number) => Math.min(1, Math.max(0, n));
      setCrop({ ...drag.crop,
        x: draft.width === side ? 0.5 : clamp(drag.crop.x - (event.clientX - drag.x) / scale / (draft.width - side)),
        y: draft.height === side ? 0.5 : clamp(drag.crop.y - (event.clientY - drag.y) / scale / (draft.height - side)),
      });
    }}>
      <CropPreview draft={draft} crop={crop} />
      <span className="profile-crop-circle" />
    </div>
    {(['size', 'x', 'y'] as const).map(key => <label className="profile-crop-slider" key={key}>
      <span>{t(key === 'size' ? 'profile.zoom' : key === 'x' ? 'profile.horizontal' : 'profile.vertical')}</span>
      <input autoComplete="off" className="settings-slider-input" type="range" min={key === 'size' ? 1 : 0} max={100} step={1}
        value={key === 'size' ? Math.round((1.01 - crop.size) * 100) : Math.round(crop[key] * 100)}
        onChange={event => setCrop({ ...crop, [key]: key === 'size' ? 1.01 - Number(event.target.value) / 100 : Number(event.target.value) / 100 })} />
    </label>)}
  </ModalDialog>;
}

export function ProfileImageEditor({ name, draft, color, remove, onDraft, onColor, onRemove, onBusy, disabled }: {
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
    <div className="profile-editor-row">
      <span className="profile-avatar profile-editor-preview" style={{ backgroundColor: color,
        color: customAccentTokens(color)?.['--custom-accent-text'] }}>
        {draft ? <CropPreview draft={draft} crop={draft.crop} /> : url ? <img src={url} alt="" /> : name.trim().charAt(0).toUpperCase() || '?'}
      </span>
      <div className="profile-editor-actions">
        <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || picking} onClick={() => void choose()}>{t(picking ? 'profile.loading' : 'profile.choose')}</button>
        {hasPhoto && <button type="button" className="btn btn-outline btn-sm" disabled={disabled || picking} onClick={() => {
          if (draft) void invoke('discard_profile_image', { token: draft.token }).catch(() => {});
          onDraft(null); onRemove(true);
        }}>{t('profile.remove')}</button>}
        {draft && <button type="button" className="btn btn-outline btn-sm" disabled={disabled || picking} onClick={() => setSelection(draft)}>{t('profile.crop')}</button>}
        {!hasPhoto && <ColorPicker label={t('profile.color')} value={color} onChange={onColor} />}
      </div>
    </div>
    <p className="field-info-text">{t('profile.formats')}</p>
    {selection && <CropDialog draft={selection} onClose={() => {
      if (selection.token !== draft?.token) void invoke('discard_profile_image', { token: selection.token }).catch(() => {});
      setSelection(null);
    }} onApply={next => {
      if (draft && draft.token !== next.token) void invoke('discard_profile_image', { token: draft.token }).catch(() => {});
      onDraft(next); onRemove(false);
    }} />}
  </div>;
}
