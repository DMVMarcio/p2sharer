import { NicknameField } from './NicknameField';
import { ProfileBannerEditor, type BannerDraft } from './ProfileBannerEditor';
import type { NicknameStyle } from '../../core/nickname_style';
import { useState, useSyncExternalStore } from 'react';
import { Upload, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { t } from '../../i18n';
import { profileImages, profileBanners, type ProfileDraft } from '../../core/profile_image';
import { contrastingTextColor } from '../../core/accent_color';
import { CropPreview, ProfileCropDialog } from './ProfileCropDialog';
import { PROFILE_CARD_COLORS } from '../../core/profile_card_color';
import { ColorPalette } from './ColorPalette';
import { ColorPicker } from './ColorPicker';
import { TooltipButton } from './TooltipButton';
import { showToast } from '../../hooks/useToast';

export function ProfileImageEditor({ name, draft, color, remove, onDraft, onColor, onRemove, onBusy, disabled, cardColor, onCardColor, onNameChange, nicknameStyle, onNicknameStyle, banner, onBanner }: {
  banner: BannerDraft; onBanner: (value: BannerDraft) => void;
  nicknameStyle: NicknameStyle; onNicknameStyle: (style: NicknameStyle) => void;
  onNameChange: (name: string) => void;
  cardColor: string | null; onCardColor: (color: string | null) => void;
  name: string; draft: ProfileDraft | null; color: string; remove: boolean; onDraft: (draft: ProfileDraft | null) => void;
  onColor: (color: string) => void; onRemove: (remove: boolean) => void; onBusy: (busy: boolean) => void; disabled: boolean;
}) {
  useSyncExternalStore(profileImages.subscribe, profileImages.snapshot);
  useSyncExternalStore(profileBanners.subscribe, profileBanners.snapshot);
  const [selection, setSelection] = useState<ProfileDraft | null>(null);
  const [picking, setPicking] = useState(false);
  const url = remove ? undefined : profileImages.url('local');
  const hasPhoto = Boolean(draft || url);
  const usesBannerOnCards = banner.enabled && Boolean(banner.image || (!banner.remove && profileBanners.url('local')));
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
    <div className="profile-editor-identity">
      <div className="profile-editor-avatar-column">
        <span className="settings-label profile-editor-avatar-label">{t('profile.photo')}</span>
        <div className="profile-editor-avatar-media">
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
          <div className="profile-editor-avatar-color">
            <ColorPicker label={t(hasPhoto ? 'profile.borderColor' : 'profile.color')} value={color} onChange={onColor}
              disabled={disabled || picking} variant="tile" />
          </div>
        </div>
        {picking && <span className="profile-loading-status" role="status">{t('profile.loading')}</span>}
      </div>
      <div className="profile-editor-details">
        <ProfileBannerEditor value={banner} onChange={onBanner} disabled={disabled || picking} onBusy={onBusy} />
        <div className="profile-editor-name">
          <label className="settings-label" htmlFor="settings-input-username">{t('message.295f254de3a9')}</label>
          <NicknameField id="settings-input-username" name={name} onNameChange={onNameChange}
            appearance={nicknameStyle} onAppearanceChange={onNicknameStyle} disabled={disabled || picking}
            placeholder={t('message.1b92c5e9d144')} />
        </div>
        {!usesBannerOnCards && <div className="profile-card-settings">
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
        </div>}
      </div>
    </div>
    {selection && <ProfileCropDialog draft={selection} onClose={() => {
      if (selection.token !== draft?.token) void invoke('discard_profile_image', { token: selection.token }).catch(() => {});
      setSelection(null);
    }} onApply={next => {
      if (draft && draft.token !== next.token) void invoke('discard_profile_image', { token: draft.token }).catch(() => {});
      onDraft(next); onRemove(false);
    }} />}
  </div>;
}
