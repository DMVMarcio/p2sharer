import { useSyncExternalStore, type HTMLAttributes, type Ref } from 'react';
import { profileImages } from '../../core/profile_image';
import { customAccentTokens } from '../../core/accent_color';

export function ProfileAvatar({ peerId = 'local', name, isLocal = false, color, className = '', ...props }: {
  peerId?: string; name: string; isLocal?: boolean; color?: string; className?: string;
} & HTMLAttributes<HTMLSpanElement> & { ref?: Ref<HTMLSpanElement> }) {
  useSyncExternalStore(profileImages.subscribe, profileImages.snapshot);
  const url = profileImages.url(peerId, isLocal);
  const background = profileImages.color(peerId, isLocal) ?? color ?? '#06b6d4';
  return <span {...props} className={`profile-avatar ${className}`} style={{ backgroundColor: background,
    color: customAccentTokens(background)?.['--custom-accent-text'] ?? 'white' }} aria-label={name}>
    {url ? <img src={url} alt="" draggable={false} /> : name.trim().charAt(0).toUpperCase() || '?'}
  </span>;
}
