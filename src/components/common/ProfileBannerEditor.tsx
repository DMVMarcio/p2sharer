import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ImagePlus, Upload, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { t } from '../../i18n';
import { BANNER_ASPECT, profileBanners, type ProfileDraft } from '../../core/profile_image';
import { CropPreview, ProfileCropDialog } from './ProfileCropDialog';
import { TooltipButton } from './TooltipButton';
import { showToast } from '../../hooks/useToast';

export interface BannerDraft {
  image: ProfileDraft | null;
  remove: boolean;
  enabled: boolean;
  blur: boolean;
}

export function ProfileBannerEditor({ value, onChange, disabled, onBusy }: {
  value: BannerDraft; onChange: (value: BannerDraft) => void; disabled: boolean; onBusy: (busy: boolean) => void;
}) {
  useSyncExternalStore(profileBanners.subscribe, profileBanners.snapshot);
  const [selection, setSelection] = useState<ProfileDraft | null>(null);
  const [picking, setPicking] = useState(false);
  const mounted = useRef(true);
  const pendingToken = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pendingToken.current) void invoke('discard_profile_image', { token: pendingToken.current }).catch(() => {});
    };
  }, []);
  const url = value.remove ? undefined : profileBanners.url('local');
  const hasBanner = Boolean(value.image || url);
  const choose = async () => {
    setPicking(true); onBusy(true);
    try {
      const picked = await invoke<Omit<ProfileDraft, 'crop'> | null>('pick_profile_image');
      if (picked) {
        if (!mounted.current || picked.width < BANNER_ASPECT) {
          void invoke('discard_profile_image', { token: picked.token }).catch(() => {});
          if (mounted.current) showToast(t('profile.invalid'));
        } else {
          pendingToken.current = picked.token;
          setSelection({ ...picked, crop: { x: 0.5, y: 0.5, size: 1 } });
        }
      }
    } catch { showToast(t('profile.invalid')); }
    finally { if (mounted.current) setPicking(false); onBusy(false); }
  };
  return <div className="profile-banner-editor">
    <span className="settings-label profile-banner-label">{t('profile.banner')}</span>
    <div className="profile-banner-upload">
      <TooltipButton tooltip={t(picking ? 'profile.loading' : 'profile.chooseBanner')}
        className="btn profile-upload-button profile-banner-button" disabled={disabled || picking}
        aria-busy={picking} onClick={() => void choose()}>
        <span className="profile-banner-preview">
          {value.image ? <CropPreview draft={value.image} crop={value.image.crop} aspect={BANNER_ASPECT} />
            : url ? <img src={url} alt="" draggable={false} /> : <ImagePlus size={28} aria-hidden="true" />}
          <span className="profile-upload-overlay" aria-hidden="true">{picking ? <span className="loading-spinner" /> : <Upload size={24} />}</span>
        </span>
      </TooltipButton>
      {hasBanner && <TooltipButton tooltip={t('profile.removeBanner')} className="btn btn-danger profile-remove-button"
        disabled={disabled || picking} onClick={() => {
          if (value.image) void invoke('discard_profile_image', { token: value.image.token }).catch(() => {});
          onChange({ ...value, image: null, remove: true });
        }}><X size={14} aria-hidden="true" /></TooltipButton>}
    </div>
    {hasBanner && <div className="profile-banner-options">
      <label className="settings-switch-row" htmlFor="profile-banner-enabled">
        <span className="settings-switch-title">{t('profile.bannerOnCard')}</span>
        <div className="modern-switch">
          <input autoComplete="off" type="checkbox" id="profile-banner-enabled" checked={value.enabled}
            disabled={disabled || picking} onChange={event => onChange({ ...value, enabled: event.target.checked })} />
          <span className="switch-slider" />
        </div>
      </label>
      {value.enabled && <label className="settings-switch-row" htmlFor="profile-banner-blur">
        <span className="settings-switch-title">{t('profile.bannerBlur')}</span>
        <div className="modern-switch">
          <input autoComplete="off" type="checkbox" id="profile-banner-blur" checked={value.blur}
            disabled={disabled || picking || !value.enabled} onChange={event => onChange({ ...value, blur: event.target.checked })} />
          <span className="switch-slider" />
        </div>
      </label>}
    </div>}
    {picking && <span className="profile-loading-status" role="status">{t('profile.loading')}</span>}
    {selection && <ProfileCropDialog draft={selection} aspect={BANNER_ASPECT} label={t('profile.cropBanner')}
      onClose={() => {
        if (pendingToken.current) void invoke('discard_profile_image', { token: pendingToken.current }).catch(() => {});
        pendingToken.current = null;
        setSelection(null);
      }} onApply={image => {
        pendingToken.current = null;
        if (value.image && value.image.token !== image.token) void invoke('discard_profile_image', { token: value.image.token }).catch(() => {});
        onChange({ ...value, image, remove: false });
      }} />}
  </div>;
}
