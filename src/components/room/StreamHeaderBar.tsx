import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { Settings2 } from 'lucide-react';
import { stateStore } from '../../core/state_store';
import React, { useEffect, useState } from 'react';
import { roomAppsService } from '../../apps/room_apps_service';
import { useRoom } from '../../hooks/useRoom';
import { useModal } from '../../hooks/useModal';
import { useStore } from '../../hooks/useStore';
import { Tooltip } from '../common/Tooltip';
import { AppWindow, Square, ChevronDown, Camera, Monitor, Plus } from 'lucide-react';
import { useContextMenu, type ContextMenuAction } from '../common/ContextMenu';
import { roomService } from '../../services/room_service';

export const StreamHeaderBar: React.FC = () => {
  useLocale();
  const [appCounts, setAppCounts] = useState(() => ({
    total: roomAppsService.getInstances().length,
    joined: roomAppsService.getJoinedInstances().length,
  }));
  useEffect(() => roomAppsService.subscribe(() => {
    const total = roomAppsService.getInstances().length;
    const joined = roomAppsService.getJoinedInstances().length;
    setAppCounts((previous) => previous.total === total && previous.joined === joined
      ? previous : { total, joined });
  }), []);
  const {
    roomSlots,
    leaveRoom,
    streamFilter,
    setStreamFilter,
  } = useRoom();
  const { openModal } = useModal();
  const openContextMenu = useContextMenu();
  const subscribedStreams = useStore((s) => s.subscribedStreams);

  const totalCount = roomSlots.length + appCounts.total;
  const isBroadcasting = roomSlots.some((slot) => slot.isLocal && slot.isStreaming);
  const streamingCount = roomSlots.filter((s) => s.isStreaming).length + appCounts.total;
  const watchingCount = roomSlots.filter(
    (s) => !s.isLocal && s.isStreaming && subscribedStreams.has(s.peerId)
  ).length + appCounts.joined;

  const startTransmission = () => {
    stateStore.set((state) => { state.editingStreamId = null; });
    openModal('screenPicker');
  };
  const handleToggleTransmission = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!isBroadcasting) { startTransmission(); return; }
    const actions: ContextMenuAction[] = roomSlots
      .filter((slot) => slot.isLocal && slot.isStreaming && slot.mediaId)
      .map((slot) => {
        const label = slot.mediaLabel || (slot.mediaKind === 'camera' ? t("message.dafb61aca12d") : t("message.2d31efc9c2ed"));
        return { id: `edit-${slot.mediaId}`, label,
          icon: slot.mediaKind === 'camera' ? <Camera size={15} /> : <Monitor size={15} />,
          onSelect: () => { roomService.editTransmission(slot.mediaId!); openModal('screenPicker'); },
          secondary: { get label() { return t("message.bc7431b85054", { v0: label }); }, icon: <Square size={14} />, danger: true,
            onSelect: () => roomService.stopTransmission(slot.mediaId!) } };
      });
    actions.push({ id: 'new-transmission', get label() { return t("message.632a0a6c5999"); }, icon: <Plus size={15} />,
      separator: true, onSelect: startTransmission });
    const bounds = event.currentTarget.getBoundingClientRect();
    openContextMenu({ currentTarget: event.currentTarget, clientX: bounds.left, clientY: bounds.bottom,
      preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() }, actions);
  };

  return (
    <div className="stream-header-bar">
      {/* Stream Filter Controls on Left */}
      <div className="stream-filter-group" role="group" aria-label={t("message.12a023948f61")}>
        <Tooltip content={t("message.b5795d28fab4", { v0: totalCount })}>
          <button
            type="button"
            className={`btn-stream-filter ${streamFilter === 'all' ? 'active' : ''}`}
            onClick={() => setStreamFilter('all')}
            aria-label={t("message.1d5d07001ab4")}
          >
            <span>{t("message.bd02b9a7d71d")}</span>
            <span className="filter-count-badge">{totalCount}</span>
          </button>
        </Tooltip>

        <Tooltip content={t("message.71108d7b0ee4", { v0: streamingCount })}>
          <button
            type="button"
            className={`btn-stream-filter ${streamFilter === 'streaming' ? 'active' : ''}`}
            onClick={() => setStreamFilter(streamFilter === 'streaming' ? 'all' : 'streaming')}
            aria-label={t("message.41b29c6a3cb4")}
          >
            <span className="filter-live-dot"></span>
            <span>{t("message.3f542b1f9fe7")}</span>
            <span className="filter-count-badge">{streamingCount}</span>
          </button>
        </Tooltip>

        <Tooltip content={t("message.de274ab87c62", { v0: watchingCount })}>
          <button
            type="button"
            className={`btn-stream-filter ${streamFilter === 'watching' ? 'active' : ''}`}
            onClick={() => setStreamFilter(streamFilter === 'watching' ? 'all' : 'watching')}
            aria-label={t("message.9e3dd618b896")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span>{t("message.b1dee94bf475")}</span>
            <span className="filter-count-badge">{watchingCount}</span>
          </button>
        </Tooltip>
      </div>

      <div className="stream-actions">
        <Tooltip content={t("message.88aff1752712")}>
          <button className="btn btn-sm btn-outline btn-compact" aria-label={t("message.7679ca8f8a85")}
            onClick={() => openModal('apps')}><AppWindow size={14} strokeWidth={2} /><span className="btn-text">{t("common.apps")}</span></button>
        </Tooltip>
        {/* Transmission Button */}
        <Tooltip content={isBroadcasting ? t("message.491c33633da0") : t("message.725623b9ce22")}>
          <button
            className={`btn btn-sm btn-compact btn-outline ${isBroadcasting ? 'btn-transmission-menu' : ''}`}
            id="btn-toggle-share-screen"
            onClick={handleToggleTransmission}
            aria-label={isBroadcasting ? t("message.491c33633da0") : t("message.85344dae041c")}
            aria-haspopup={isBroadcasting ? 'menu' : undefined}
          >
            <span className={`stream-sharing-indicator ${isBroadcasting ? 'active' : ''}`} id="stream-sharing-dot"></span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3" />
              <path d="M8 21h8" />
              <path d="M12 17v4" />
              <path d="m17 8 5-5" />
              <path d="M17 3h5v5" />
            </svg>
            <span className="btn-text" id="label-share-screen">
              {isBroadcasting ? t("message.15589e9e374d") : t("message.85344dae041c")}
            </span>
            {isBroadcasting && <ChevronDown className="transmission-chevron" size={12} aria-hidden="true" />}
          </button>
        </Tooltip>

        {/* Audio Filter Config */}
        <Tooltip content={t("message.44d9ce86bda1")}>
          <button
            className="btn btn-sm btn-outline btn-compact"
            id="btn-open-audio-filter"
            onClick={() => openModal('audioFilter')}
            aria-label={t("message.44d9ce86bda1")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="4" x2="4" y1="21" y2="14" />
              <line x1="4" x2="4" y1="10" y2="3" />
              <line x1="12" x2="12" y1="21" y2="12" />
              <line x1="12" x2="12" y1="8" y2="3" />
              <line x1="20" x2="20" y1="21" y2="16" />
              <line x1="20" x2="20" y1="12" y2="3" />
              <line x1="1" x2="7" y1="14" y2="14" />
              <line x1="9" x2="15" y1="8" y2="8" />
              <line x1="17" x2="23" y1="16" y2="16" />
            </svg>
            <span className="btn-text">{t("message.195c60bb2325")}</span>
          </button>
        </Tooltip>

        {/* Room settings */}
        <Tooltip content={t("message.7efe8d00498f")}>
          <button
            className="btn btn-sm btn-outline btn-compact"
            id="btn-open-room-security"
            onClick={() => openModal('roomSecurity')}
            aria-label={t("message.7efe8d00498f")}
          >
            <Settings2 size={14} aria-hidden="true" />
            <span className="btn-text" id="label-room-security">{t("message.46a6407e52eb")}</span>
          </button>
        </Tooltip>

        {/* Leave Room */}
        <Tooltip content={t("message.7b7b91d7fe87")}>
          <button
            className="btn btn-sm btn-danger btn-compact"
            id="btn-leave-room"
            onClick={leaveRoom}
            aria-label={t("message.7b7b91d7fe87")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" x2="9" y1="12" y2="12" />
            </svg>
            <span className="btn-text">{t("message.2d023dea2a9d")}</span>
          </button>
        </Tooltip>
      </div>
    </div>
  );
};
