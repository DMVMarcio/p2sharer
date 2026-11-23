import { Nickname } from '../common/Nickname';
import { PlatformBadge } from '../common/PlatformBadge';
import { getLocalPlatform } from '../../core/platform';
import { useRoomCardLayoutActions } from './RoomCardLayoutContext';
import { contrastingTextColor } from '../../core/accent_color';
import { profileImages, profileBanners } from '../../core/profile_image';
import { ProfileAvatar } from '../common/ProfileAvatar';
import { profileAction } from '../common/profile_actions';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { roomService } from '../../services/room_service';
import { stateStore } from '../../core/state_store';
import React from 'react';
import { RoomSlotInfo } from '../../core/types';
import { useRoom } from '../../hooks/useRoom';
import { useStore } from '../../hooks/useStore';
import { Tooltip } from '../common/Tooltip';
import { WatchersTooltipContent } from './WatchersTooltipContent';
import { Focus, Grid2X2, Play, MonitorUp, Mic, MicOff, HeadphoneOff, VolumeX } from 'lucide-react';
import { useContextMenu, type ContextMenuAction } from '../common/ContextMenu';
import { useModal } from '../../hooks/useModal';
import { getUserVoiceActions } from './voice_user_actions';

interface ParticipantCardProps {
  slot: RoomSlotInfo;
  isFeatured?: boolean;
  inTray?: boolean;
  isSelectedFeatured?: boolean;
}

export const ParticipantCard: React.FC<ParticipantCardProps> = ({
  slot,
  isFeatured = false,
  inTray = false,
  isSelectedFeatured = false,
}) => {
  useLocale();
  React.useSyncExternalStore(profileImages.subscribe, profileImages.snapshot);
  React.useSyncExternalStore(profileBanners.subscribe, profileBanners.snapshot);
  const { togglePin, requestStream, layoutMode, returnToGrid, inVoice, voiceMicMuted, voiceDeafened, isLocalSpeaking, voicePeers } = useRoom();
  const openContextMenu = useContextMenu();
  const layoutActions = useRoomCardLayoutActions();
  const { openModal } = useModal();
  const subscribedStreams = useStore((s) => s.subscribedStreams);

  const ownerPeerId = slot.ownerPeerId ?? slot.peerId;
  const remoteVoice = !slot.isLocal ? (voicePeers ?? {})[ownerPeerId] : undefined;
  const userInVoice = slot.isLocal ? Boolean(inVoice) : Boolean(remoteVoice?.inVoice);
  const userSpeaking = slot.isLocal ? Boolean(inVoice && isLocalSpeaking) : Boolean(remoteVoice?.speaking);
  const userMuted = slot.isLocal ? Boolean(inVoice && voiceMicMuted) : Boolean(remoteVoice?.muted);
  const userDeafened = slot.isLocal ? Boolean(inVoice && voiceDeafened) : Boolean(remoteVoice?.deafened);
  const userLocallyMuted = !slot.isLocal
    ? Boolean(roomService.getPeerVoiceVolume?.(ownerPeerId, slot.ownerPublicKey, slot.senderName)?.muted)
    : false;

  const background = profileImages.background(ownerPeerId, slot.isLocal, slot.color);
  const banner = profileBanners.cardBanner(ownerPeerId, slot.isLocal);
  const blurBanner = profileBanners.blur(ownerPeerId, slot.isLocal);
  const isSubscribed = subscribedStreams.has(slot.peerId);
  const watchers = slot.watchers || [];
  const watchersCount = watchers.length;

  const handleCardClick = () => {
    togglePin(slot.peerId);
  };

  const handleWatchClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    requestStream(slot.peerId);
  };

  return (
    <div
      className={`participant-card ${isFeatured ? 'featured' : ''} ${inTray ? 'in-tray' : ''} ${isSelectedFeatured ? 'selected-featured' : ''} ${userSpeaking ? 'is-voice-speaking' : ''}`}
      data-peer-id={slot.peerId}
      style={{ '--user-color': slot.color, '--card-color': background, '--card-text': banner ? '#ffffff' : contrastingTextColor(background) } as React.CSSProperties}
      onClick={handleCardClick}
      tabIndex={0}
      onContextMenu={(event) => {
        const actions: ContextMenuAction[] = [profileAction({ peerId: ownerPeerId, name: slot.senderName, isLocal: slot.isLocal, color: slot.color })];
        if (!slot.isLocal) {
          actions.push(...getUserVoiceActions({ peerId: ownerPeerId, publicKey: slot.ownerPublicKey, username: slot.senderName }));
        }
        if (layoutMode === 'spotlight' && inTray && !isSelectedFeatured && slot.isStreaming) actions.push({ id: 'overlay', get label() { return t("message.1c2685f76e69"); }, onSelect: () => roomService.overlayStream(slot.peerId) });
        if (!isFeatured && !isSelectedFeatured) actions.push({ id: 'feature', get label() { return t("message.3c31d7d451bc"); }, icon: <Focus size={15} />, onSelect: () => togglePin(slot.peerId) });
        if (layoutMode === 'spotlight') actions.push({ id: 'grid', get label() { return t("message.2e00d3a9b870"); }, icon: <Grid2X2 size={15} />,
          onSelect: returnToGrid });
        if (!slot.isLocal && slot.isStreaming && !isSubscribed) actions.push({ id: 'watch', get label() { return t("message.5a49c69bab6b"); }, icon: <Play size={15} />, onSelect: () => requestStream(slot.peerId) });
        if (slot.isLocal && !slot.isStreaming) actions.push({ id: 'share', get label() { return t("message.85344dae041c"); }, icon: <MonitorUp size={15} />, onSelect: () => { stateStore.set((state) => { state.editingStreamId = null; }); openModal('screenPicker'); } });
        openContextMenu(event, [...actions, ...layoutActions]);
      }}
    >
      {banner && <div className={`profile-card-banner${blurBanner ? ' is-blurred' : ''}`} aria-hidden="true">
        <img src={banner} alt="" draggable={false} />
      </div>}
      {/* Featured badge when in tray */}
      {inTray && isSelectedFeatured && (
        <span className="selected-featured-badge">
          <span className="selected-featured-badge-dot"></span>
        </span>
      )}

      {/* If remote and is streaming but not subscribed, show AO VIVO and watchers (omitted in bottom tray) */}
      {!inTray && !slot.isLocal && slot.isStreaming && !isSubscribed && (
        <>
          <span className="badge-live-stream">
            <span className="badge-live-dot"></span>{t("message.b7c19868a9a8")}</span>
          {watchersCount > 0 && (
            <Tooltip
              interactive
              tooltipClassName="watchers-tooltip"
              content={<WatchersTooltipContent watchers={watchers} />}
            >
              <div
                className="badge-live-watchers"
                onClick={(e) => e.stopPropagation()}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
                <span>{watchersCount}  {t("message.00c112b70486")}</span>
              </div>
            </Tooltip>
          )}
        </>
      )}

      <ProfileAvatar peerId={slot.ownerPeerId ?? slot.peerId} name={slot.senderName}
        isLocal={slot.isLocal} color={slot.color} className="participant-avatar-badge" />

      <div className="participant-name-row">
        <span className="participant-avatar-label"><Nickname name={slot.senderName} peerId={ownerPeerId} isLocal={slot.isLocal} />{slot.mediaLabel ? ` · ${slot.mediaLabel}` : ""}</span>
        <PlatformBadge platform={slot.platform ?? (slot.isLocal ? getLocalPlatform() : 'desktop')} size={11} />
        {slot.isLocal && <span className="badge-you">{t("message.a03099f135b1")}</span>}
        {userInVoice && (
          <span className={`participant-voice-badges${userSpeaking ? ' is-speaking' : ''}`}>
            {userLocallyMuted && (
              <Tooltip content={t('voice.statusLocallyMuted')}>
                <span className="participant-voice-badge is-muted" aria-label={t('voice.statusLocallyMuted')}>
                  <VolumeX size={11} aria-hidden="true" />
                </span>
              </Tooltip>
            )}
            {userDeafened ? (
              <Tooltip content={t('voice.statusDeafened')}>
                <span className="participant-voice-badge is-deafened" aria-label={t('voice.statusDeafened')}>
                  <HeadphoneOff size={11} aria-hidden="true" />
                </span>
              </Tooltip>
            ) : userMuted ? (
              <Tooltip content={t('voice.statusMuted')}>
                <span className="participant-voice-badge is-muted" aria-label={t('voice.statusMuted')}>
                  <MicOff size={11} aria-hidden="true" />
                </span>
              </Tooltip>
            ) : (
              <Tooltip content={userSpeaking ? t('voice.statusSpeaking') : t('voice.statusInVoice')}>
                <span className={`participant-voice-badge${userSpeaking ? ' is-speaking' : ''}`} aria-label={userSpeaking ? t('voice.statusSpeaking') : t('voice.statusInVoice')}>
                  <Mic size={11} aria-hidden="true" />
                </span>
              </Tooltip>
            )}
          </span>
        )}
      </div>

      {!inTray && !slot.isLocal && !slot.isStreaming && slot.connectionState === 'connecting' && (
        <div className="participant-status-text">
          {t("message.de1237d241d3")}
        </div>
      )}

      {!inTray && !slot.isLocal && slot.isStreaming && isSubscribed && !slot.stream && (
        <div className="participant-status-text">
          {t("message.3bc3a2cd970b")}</div>
      )}

      {!slot.isLocal && slot.isStreaming && !isSubscribed && (
        <div className="participant-action-row">
          <button className="btn-watch-stream" onClick={handleWatchClick}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            <span>{t("message.81da4da84d51")}</span>
          </button>
        </div>
      )}
    </div>
  );
};
