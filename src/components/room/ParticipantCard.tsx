import { contrastingTextColor } from '../../core/accent_color';
import { profileImages } from '../../core/profile_image';
import { ProfileAvatar } from '../common/ProfileAvatar';
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
import { Focus, Grid2X2, Play, MonitorUp } from 'lucide-react';
import { useContextMenu, type ContextMenuAction } from '../common/ContextMenu';
import { useModal } from '../../hooks/useModal';

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
  const { togglePin, requestStream, layoutMode, returnToGrid } = useRoom();
  const openContextMenu = useContextMenu();
  const { openModal } = useModal();
  const subscribedStreams = useStore((s) => s.subscribedStreams);

  const background = profileImages.background(slot.ownerPeerId ?? slot.peerId, slot.isLocal, slot.color);
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
      className={`participant-card ${isFeatured ? 'featured' : ''} ${inTray ? 'in-tray' : ''} ${isSelectedFeatured ? 'selected-featured' : ''}`}
      data-peer-id={slot.peerId}
      style={{ '--user-color': slot.color, '--card-color': background, '--card-text': contrastingTextColor(background) } as React.CSSProperties}
      onClick={handleCardClick}
      tabIndex={0}
      onContextMenu={(event) => {
        const actions: ContextMenuAction[] = [];
        if (layoutMode === 'spotlight' && inTray && !isSelectedFeatured && slot.isStreaming) actions.push({ id: 'overlay', get label() { return t("message.1c2685f76e69"); }, onSelect: () => roomService.overlayStream(slot.peerId) });
        if (!isFeatured && !isSelectedFeatured) actions.push({ id: 'feature', get label() { return t("message.3c31d7d451bc"); }, icon: <Focus size={15} />, onSelect: () => togglePin(slot.peerId) });
        if (layoutMode === 'spotlight') actions.push({ id: 'grid', get label() { return t("message.2e00d3a9b870"); }, icon: <Grid2X2 size={15} />,
          onSelect: returnToGrid });
        if (!slot.isLocal && slot.isStreaming && !isSubscribed) actions.push({ id: 'watch', get label() { return t("message.5a49c69bab6b"); }, icon: <Play size={15} />, onSelect: () => requestStream(slot.peerId) });
        if (slot.isLocal && !slot.isStreaming) actions.push({ id: 'share', get label() { return t("message.85344dae041c"); }, icon: <MonitorUp size={15} />, onSelect: () => { stateStore.set((state) => { state.editingStreamId = null; }); openModal('screenPicker'); } });
        openContextMenu(event, actions);
      }}
    >
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
        <span className="participant-avatar-label">{slot.senderName}{slot.mediaLabel ? ` · ${slot.mediaLabel}` : ""}</span>
        {slot.isLocal && <span className="badge-you">{t("message.a03099f135b1")}</span>}
      </div>

      {!inTray && slot.isLocal && !slot.isStreaming && (
        <div className="participant-status-text">{t("message.f502620127f2")}</div>
      )}

      {!inTray && !slot.isLocal && !slot.isStreaming && (
        <div className="participant-status-text">
          {slot.connectionState === 'connecting' ? t("message.de1237d241d3") : t("message.5e06d5da9c12")}
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
