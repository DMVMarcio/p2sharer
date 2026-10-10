import { useSyncExternalStore } from 'react';
import { UserRound, Clock, MessageCircle, Files, Download, Upload, Phone, Trophy } from 'lucide-react';
import { ModalDialog } from '../common/ModalDialog';
import { ProfileAvatar } from '../common/ProfileAvatar';
import { Nickname } from '../common/Nickname';
import { modalManager } from '../../hooks/useModal';
import { useStore } from '../../hooks/useStore';
import { useRoom } from '../../hooks/useRoom';
import { profileImages, profileBanners } from '../../core/profile_image';
import { profileStats, formatProfileDuration } from '../../core/profile_stats';
import { formatFileSize } from '../../core/file_size';
import { getLanguage, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';

export function ProfileModal() {
  useLocale();
  useSyncExternalStore(profileImages.subscribe, profileImages.snapshot);
  useSyncExternalStore(profileBanners.subscribe, profileBanners.snapshot);
  useSyncExternalStore(profileStats.subscribe, profileStats.snapshot);
  const username = useStore(state => state.username);
  const { peers } = useRoom();
  const target = modalManager.getProfileTarget();
  if (!target) return null;
  const name = target.isLocal ? username : peers.find(peer => peer.id === target.peerId)?.username ?? target.name;
  const banner = profileBanners.url(target.peerId, target.isLocal);
  const stats = profileStats.get(target.peerId, target.isLocal);
  const number = (value: number) => new Intl.NumberFormat(getLanguage()).format(value);
  const tiles = stats ? [
    { label: 'profile.stats.callTime', value: formatProfileDuration(stats.callMs), icon: Clock },
    { label: 'profile.stats.messages', value: number(stats.messages), icon: MessageCircle },
    { label: 'profile.stats.filesSent', value: number(stats.filesSent), icon: Files },
    { label: 'profile.stats.filesReceived', value: number(stats.filesReceived), icon: Download },
    { label: 'profile.stats.calls', value: number(stats.calls), icon: Phone },
    { label: 'profile.stats.longestCall', value: formatProfileDuration(stats.longestCallMs), icon: Trophy },
    { label: 'profile.stats.bytesSent', value: formatFileSize(stats.bytesSent), icon: Upload },
    { label: 'profile.stats.bytesReceived', value: formatFileSize(stats.bytesReceived), icon: Download },
  ] : [];
  return <ModalDialog title={t('profile.title')} icon={<UserRound size={20} />} className="profile-view-modal"
    onClose={() => modalManager.open(null)} footer={close => <>
      {target.isLocal && <button className="btn btn-secondary" type="button" onClick={() => modalManager.open('settings')}>{t('profile.edit')}</button>}
      <button type="button" className="btn btn-primary" onClick={close}>{t('message.0f2bd88ef0ac')}</button>
    </>}>
    <div className={`profile-view-banner${banner ? '' : ' is-empty'}`} style={{ backgroundColor: profileImages.background(target.peerId, target.isLocal, target.color) }}>
      {banner && <img src={banner} alt="" draggable={false} />}
    </div>
    <div className="profile-view-identity">
      <ProfileAvatar peerId={target.peerId} isLocal={target.isLocal} name={name} color={target.color} className="profile-view-avatar" />
      <h3><Nickname name={name} peerId={target.peerId} isLocal={target.isLocal} /></h3>
      {target.isLocal && <span className="badge-you">{t('message.a03099f135b1')}</span>}
    </div>
    <h4>{t('profile.stats.title')}</h4>
    {stats ? <dl className="profile-stats-grid">{tiles.map(({ label, value, icon: Icon }) => <div key={label}>
      <dt><Icon size={16} aria-hidden="true" />{t(label)}</dt><dd>{value}</dd>
    </div>)}</dl> : <p className="profile-stats-note">{t('profile.stats.unavailable')}</p>}
    <p className="profile-stats-note">{t(target.isLocal ? 'profile.stats.localNote' : 'profile.stats.remoteNote')}</p>
  </ModalDialog>;
}
