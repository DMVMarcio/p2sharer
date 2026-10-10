import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useMemo, useRef, useLayoutEffect, useEffect, useState, useCallback } from 'react';
import { roomAppsService } from '../../apps/room_apps_service';
import { RoomAppSlot } from '../../apps/RoomAppSlot';
import { PersistentRoomApps } from '../../apps/PersistentRoomApps';
import type { RoomAppInstance } from '../../apps/types';
import { useRoom } from '../../hooks/useRoom';
import { useStore } from '../../hooks/useStore';
import { VideoCard } from './VideoCard';
import { StreamOverlay } from './StreamOverlay';
import { roomService } from '../../services/room_service';
import { ParticipantCard } from './ParticipantCard';
import { RoomSlotInfo } from '../../core/types';
import { useRoomCardGestures } from '../../hooks/useRoomCardGestures';
import { calculateCardLayout } from '../../core/room_card_layout';
import { RoomCardFrame, RoomCardPlaceholder } from './RoomCardFrame';
import { RoomCardLayoutContext, RoomCardLayoutSurface } from './RoomCardLayoutContext';

export const RoomVideoContainer: React.FC = () => {
  useLocale();
  const [, setAppsTick] = useState(0);
  const appVisibilityRef = useRef('');
  useEffect(() => roomAppsService.subscribe(() => {
    const ids = roomAppsService.getInstances().map((instance) => instance.id).join(',');
    const joinedIds = roomAppsService.getJoinedInstances().map((instance) => instance.id).join(',');
    const visibility = `${ids}|${joinedIds}`;
    if (visibility !== appVisibilityRef.current) {
      appVisibilityRef.current = visibility;
      setAppsTick((tick) => tick + 1);
    }
  }), []);
  const appInstances = roomAppsService.getInstances();
  const {
    roomSlots,
    layoutMode,
    pinnedPeerId,
    isSpotlightTrayCollapsed,
    toggleSpotlightTray,
    streamFilter,
    setStreamFilter,
  } = useRoom();
  const subscribedStreams = useStore((s) => s.subscribedStreams);
  const streamOverlays = useStore((s) => s.streamOverlays);
  const dismissedAutoOverlays = useStore((s) => s.dismissedAutoOverlays);

  const gridViewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [cardOrder, setCardOrder] = useState<string[]>([]);
  const [cardSizes, setCardSizes] = useState<Record<string, number>>({});
  const [manualRows, setManualRows] = useState<string[][] | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const currentRoomCode = useStore(s => s.currentRoomCode);
  useEffect(() => { setCardOrder([]); setCardSizes({}); setManualRows(null); }, [currentRoomCode]);
  useLayoutEffect(() => {
    const node = gridViewportRef.current;
    if (!node || layoutMode !== 'grid') return;
    const measure = () => setViewport({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [layoutMode]);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const appSlotsRef = useRef(new Map<string, HTMLDivElement>());
  const registerAppSlot = useCallback((key: string, element: HTMLDivElement | null) => {
    if (element) appSlotsRef.current.set(key, element);
    else appSlotsRef.current.delete(key);
  }, []);
  const shouldRenderVideo = (slot: RoomSlotInfo): boolean => {
    return Boolean(
      (slot.isLocal && slot.isStreaming && slot.stream) ||
      (!slot.isLocal && slot.isStreaming && subscribedStreams.has(slot.peerId) && slot.stream)
    );
  };

  const filteredSlots = useMemo(() => {
    return roomSlots.filter((slot) => {
      if (streamFilter === 'streaming') {
        return slot.isStreaming;
      }
      if (streamFilter === 'watching') {
        return !slot.isLocal && slot.isStreaming && subscribedStreams.has(slot.peerId);
      }
      return true;
    });
  }, [roomSlots, streamFilter, subscribedStreams]);

  const visibleApps = streamFilter === 'watching' ? roomAppsService.getJoinedInstances() : appInstances;
  const availableEntries: Array<RoomSlotInfo | RoomAppInstance> = [...filteredSlots, ...visibleApps];
  const entryId = (entry: RoomSlotInfo | RoomAppInstance) => 'peerId' in entry ? entry.peerId : `app:${entry.id}`;
  const availableIds = availableEntries.map(entryId);
  const ids = [...cardOrder.filter(id => availableIds.includes(id)), ...availableIds.filter(id => !cardOrder.includes(id))];
  const saveOrder = (next: string[], rows?: string[][]) => {
    if (rows) {
      const hidden = (manualRows || []).map(row => row.filter(id => !availableIds.includes(id))).filter(row => row.length);
      setManualRows([...rows, ...hidden]);
      setCardOrder([...next, ...hidden.flat()]);
      return;
    }
    // Hidden entries retain their places while visible entries exchange their positions.
    const full = [...cardOrder, ...availableIds.filter(id => !cardOrder.includes(id))];
    let index = 0;
    setCardOrder(full.map(id => availableIds.includes(id) ? next[index++] : id));
    setManualRows(previous => {
      let index = 0;
      return previous?.map(row => row.map(id => availableIds.includes(id) ? next[index++] : id)) ?? null;
    });
  };
  const layout = calculateCardLayout(ids, viewport.width, viewport.height, cardSizes, manualRows);
  const gestures = useRoomCardGestures({ mode: layoutMode, ids, layout, sizes: cardSizes,
    rootRef: videoContainerRef, surfaceRef, onOrder: saveOrder,
    onResize: (id, size) => setCardSizes(previous => ({ ...previous, [id]: size })) });
  const validDraft = gestures.draft && gestures.draft.initial.length === ids.length &&
    gestures.draft.initial.every((id, index) => id === ids[index]) ? gestures.draft : null;
  const displayIds = validDraft && !validDraft.edge ? validDraft.order : ids;
  const entries = displayIds.map(id => availableEntries.find(entry => entryId(entry) === id)!);
  const draftRows = validDraft?.rows ?? (manualRows ? (() => {
    let index = 0;
    return manualRows.map(row => row.map(id => availableIds.includes(id) ? displayIds[index++] : id));
  })() : null);
  const displayLayout = calculateCardLayout(displayIds, viewport.width, viewport.height, cardSizes, draftRows);
  const floating = validDraft ? gestures.floatingStyle() : undefined;
  const slotIdsKey = displayIds.join(',');
  const layoutKey = `${slotIdsKey}:${layoutMode}:${pinnedPeerId}:${isSpotlightTrayCollapsed}:${streamFilter}:${JSON.stringify(displayLayout.cards)}:${JSON.stringify(floating)}`;
  const resetLayout = () => { setManualRows(null); setCardSizes({}); setCardOrder([]); };
  const renderMovableCard = (slot: RoomSlotInfo | RoomAppInstance, inTray = false) => {
    const id = entryId(slot);
    const placement = displayLayout.cards.find(card => card.id === id);
    const dragging = gestures.draggingId === id;
    return <React.Fragment key={id}>
      {inTray && dragging && <RoomCardPlaceholder key={`placeholder:${id}`} />}
      <RoomCardFrame key={id} id={id} cardRef={gestures.cardRef(id)} dragging={dragging} resizable={!inTray}
        style={dragging ? floating : inTray ? undefined : placement && { position: 'absolute', left: placement.left, top: placement.top,
          width: placement.width, height: placement.height }}>
        {renderSlotCard(slot, false, inTray, inTray && id === (featuredSlot && entryId(featuredSlot)))}
      </RoomCardFrame>
    </React.Fragment>;
  };

  const featuredSlot = entries.find((s) => entryId(s) === pinnedPeerId) || entries[0];
  const featuredMedia = featuredSlot && 'peerId' in featuredSlot ? featuredSlot : undefined;
  const automaticCameras = featuredMedia?.mediaKind === 'screen' && shouldRenderVideo(featuredMedia)
    ? roomSlots.filter((slot) => slot.mediaKind === 'camera' && slot.isStreaming &&
      slot.ownerPeerId === featuredMedia.ownerPeerId &&
      !(dismissedAutoOverlays[featuredMedia.peerId] || []).includes(slot.peerId)) : [];
  const overlayKeys = featuredMedia ? [...new Set([...(streamOverlays[featuredMedia.peerId] || []), ...automaticCameras.map((slot) => slot.peerId)])] : [];
  const overlays = overlayKeys.map((key) => roomSlots.find((slot) => slot.peerId === key))
    .filter((slot): slot is RoomSlotInfo => !!slot && slot.isStreaming && slot.peerId !== featuredMedia?.peerId);
  const overlayKey = overlays.map((slot) => slot.peerId).join('|');
  useEffect(() => {
    if (layoutMode !== 'spotlight') return;
    for (const slot of overlays) if (!slot.isLocal && !subscribedStreams.has(slot.peerId)) roomService.requestStream(slot.peerId);
  }, [layoutMode, overlayKey, subscribedStreams]);

  const renderSlotCard = (
    slot: RoomSlotInfo | RoomAppInstance,
    isFeatured = false,
    inTray = false,
    isSelectedFeatured = false
  ) => {
    if (!('peerId' in slot)) return <RoomAppSlot key={slot.id} instance={slot}
      registerSlot={registerAppSlot}
      role={inTray ? 'tray' : isFeatured ? 'featured' : 'grid'} selected={isSelectedFeatured} />;
    if (shouldRenderVideo(slot)) {
      return (
        <VideoCard
          key={slot.peerId}
          slot={slot}
          isFeatured={isFeatured}
          inTray={inTray}
          isSelectedFeatured={isSelectedFeatured}
        >
          {isFeatured && featuredMedia && overlays.map((overlay, index) => <StreamOverlay key={overlay.peerId}
            slot={overlay} target={featuredMedia.peerId} index={index} />)}
        </VideoCard>
      );
    }
    return (
      <ParticipantCard
        key={slot.peerId}
        slot={slot}
        isFeatured={isFeatured}
        inTray={inTray}
        isSelectedFeatured={isSelectedFeatured}
      />
    );
  };

  return (
    <RoomCardLayoutContext.Provider value={resetLayout}>
    <RoomCardLayoutSurface className={`video-container ${gestures.draggingId ? 'is-arranging-cards' : ''}`} id="room-video-container" ref={videoContainerRef} {...gestures.rootProps}>
      {/* GRID VIEW */}
      <div
        ref={gridViewportRef}
        className={`streams-grid-wrapper layout-grid ${layoutMode !== 'grid' ? 'hidden' : ''}`}
        id="streams-grid-wrapper"
      >
        {layoutMode === 'grid' && (
          entries.length > 0 ? (
            <div className="room-card-canvas" ref={surfaceRef} style={{ height: displayLayout.height }}>
              {entries.map(slot => renderMovableCard(slot))}
              {gestures.draggingId && (() => {
                const placement = displayLayout.cards.find(card => card.id === gestures.draggingId);
                return placement && <RoomCardPlaceholder style={{ position: 'absolute', left: placement.left, top: placement.top,
                  width: placement.width, height: placement.height }} />;
              })()}
            </div>
          ) : (
            <div className="stream-filter-empty-state">
              <p className="filter-empty-title">{t("message.4f9d41039012")}</p>
              <button
                className="btn btn-sm btn-outline filter-empty-btn"
                onClick={() => setStreamFilter('all')}
              >
                {t("message.0a0d57462f8f")}{roomSlots.length})
              </button>
            </div>
          )
        )}
      </div>

      {/* SPOTLIGHT STAGE */}
      <div
        className={`spotlight-stage ${layoutMode !== 'spotlight' ? 'hidden' : ''}`}
        id="spotlight-stage"
      >
        {layoutMode === 'spotlight' && (
          <>
            {/* Featured Area */}
            <div className="spotlight-featured-area" id="spotlight-featured-area">
              {featuredSlot ? (
                renderSlotCard(featuredSlot, true, false, false)
              ) : (
                <div className="stream-filter-empty-state">
                  <p className="filter-empty-title">{t("message.9490bd6a385d")}</p>
                  <button
                    className="btn btn-sm btn-outline filter-empty-btn"
                    onClick={() => setStreamFilter('all')}
                  >
                    {t("message.0a0d57462f8f")}{roomSlots.length})
                  </button>
                </div>
              )}
            </div>

            {/* Bottom Tray */}
            <div
              className={`spotlight-tray-container ${isSpotlightTrayCollapsed ? 'collapsed' : ''}`}
              id="spotlight-tray-container"
            >
              <button
                className="btn-toggle-spotlight-tray"
                id="btn-toggle-spotlight-tray"
                aria-label={t("message.b4479dd728f5")}
                onClick={toggleSpotlightTray}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
              <div ref={layoutMode === 'spotlight' ? surfaceRef : undefined} className="spotlight-tray-strip" id="spotlight-tray-strip">
                {entries.map(slot => renderMovableCard(slot, true))}
              </div>
            </div>
          </>
        )}
      </div>
      <PersistentRoomApps instances={appInstances} layoutMode={layoutMode}
        featuredId={layoutMode === 'spotlight' && featuredSlot ? entryId(featuredSlot) : undefined}
        layoutKey={layoutKey} draggingId={gestures.draggingId}
        rootRef={videoContainerRef} slotsRef={appSlotsRef} />
    </RoomCardLayoutSurface>
    </RoomCardLayoutContext.Provider>
  );
};
