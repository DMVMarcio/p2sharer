import { Nickname } from '../common/Nickname';
import { ProfileAvatar } from '../common/ProfileAvatar';
import { useRoomCardLayoutActions } from './RoomCardLayoutContext';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { stateStore } from '../../core/state_store';
import { useModal } from '../../hooks/useModal';
import { formatFrameRate } from '../../core/media_streams';
import { useStreamPointer } from '../../hooks/useStreamPointer';
import { StreamPointerToggle } from './StreamPointerToggle';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RoomSlotInfo } from '../../core/types';
import { useRoom } from '../../hooks/useRoom';
import { useStore } from '../../hooks/useStore';
import { useStreamZoom } from '../../hooks/useStreamZoom';
import { audioContextManager } from '../../audio/audio_context_manager';
import { roomService } from '../../services/room_service';
import { pipService } from '../../services/pip_service';
import { ZoomControlBar } from './ZoomControlBar';
import { Tooltip } from '../common/Tooltip';
import { StreamStatsOverlay } from './StreamStatsOverlay';
import { Grid2X2, Focus, Eye, EyeOff, Maximize, PanelsTopLeft, PictureInPicture2, RotateCcw, Volume2, VolumeX, Square, MonitorUp } from 'lucide-react';
import { useContextMenu, type ContextMenuAction } from '../common/ContextMenu';

interface VideoCardProps {
  children?: React.ReactNode;
  slot: RoomSlotInfo;
  isFeatured?: boolean;
  inTray?: boolean;
  isSelectedFeatured?: boolean;
}

export const VideoCard: React.FC<VideoCardProps> = ({
  children,
  slot,
  isFeatured = false,
  inTray = false,
  isSelectedFeatured = false,
}) => {
  useLocale();
  const { togglePin, stopWatchingStream, getPeerPing, layoutMode, returnToGrid } = useRoom();
  const openContextMenu = useContextMenu();
  const { openModal } = useModal();
  const defaultResolution = useStore((s) => s.currentResolution);
  const defaultFps = useStore((s) => s.currentFps);
  const defaultBitrate = useStore((s) => s.currentBitrate);
  const capture = slot.mediaId ? roomService.localCaptures.get(slot.mediaId) : undefined;
  const currentResolution = capture ? { ...capture.resolution, label: `${capture.resolution.height}p` } : defaultResolution;
  const currentFps = capture?.fps || defaultFps;
  const currentBitrate = capture?.bitrate || defaultBitrate;
  const isPipActive = useStore((s) => s.isPeerInPip(slot.peerId));
  const audioTracksKey = slot.stream?.getAudioTracks().map(track => `${track.id}:${track.readyState}`).join(',');

  const [liveFps, setLiveFps] = useState<number>(() => (slot.isLocal ? currentFps : 60));
  const [liveBitrate, setLiveBitrate] = useState<number>(0);
  const [remoteResolution, setRemoteResolution] = useState<string>('1080p');
  const [livePing, setLivePing] = useState<number | null>(null);

  const [volume, setVolume] = useState<number>(100);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [lastVolume, setLastVolume] = useState<number>(100);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const showLocalPreview = useStore((s) => s.localPreviewStreams[slot.peerId] ?? (slot.mediaKind === 'camera'));
  const setShowLocalPreview = (visible: boolean) => stateStore.set((s) => {
    s.localPreviewStreams = { ...s.localPreviewStreams, [slot.peerId]: visible };
  });
  const [isHudPinned, setIsHudPinned] = useState<boolean>(false);
  const [activeTooltips, setActiveTooltips] = useState<number>(0);
  const [isVideoReady, setIsVideoReady] = useState<boolean>(() => Boolean(slot.isLocal));

  const handleTooltipOpenChange = useCallback((open: boolean) => {
    setActiveTooltips((prev) => Math.max(0, prev + (open ? 1 : -1)));
  }, []);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const {
    zoom,
    pan,
    isDragging,
    didDragRef,
    setZoomDirect,
    stepZoomLevel,
    resetZoom,
    handleMouseDown,
    handleDoubleClick,
  } = useStreamZoom(cardRef, slot.stream, !inTray);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === cardRef.current);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  const handleToggleFullscreen = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (document.fullscreenElement !== cardRef.current) {
      if (cardRef.current?.requestFullscreen) {
        cardRef.current.requestFullscreen().catch(() => {});
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    }
  };

  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const currentStreamRef = useRef(slot.stream);
  currentStreamRef.current = slot.stream;

  const pointer = useStreamPointer(cardRef, videoElementRef, slot.peerId, slot.pointerEligible !== false && !slot.isLocal && !inTray && !isPipActive && !!slot.stream,
    slot.stream, false, slot.pointerEligible !== false && !isPipActive && !!slot.stream && !(inTray && isSelectedFeatured) && (!slot.isLocal || showLocalPreview));


  const cleanupVideoElement = useCallback((el: HTMLVideoElement | null) => {
    if (!el) return;
    try {
      el.pause();
      el.srcObject = null;
      el.removeAttribute('src');
      el.load();
    } catch {}
  }, []);

  const videoRef = useCallback(
    (el: HTMLVideoElement | null) => {
      if (videoElementRef.current && videoElementRef.current !== el) {
        cleanupVideoElement(videoElementRef.current);
      }
      videoElementRef.current = el;

      if (el) {
        const stream = currentStreamRef.current;
        if (stream) {
          if (el.srcObject !== stream) {
            el.srcObject = stream;
            el.play().catch(() => {});
          } else if (el.paused) {
            el.play().catch(() => {});
          }
          if (!slot.isLocal && el.readyState >= 2 && el.videoWidth > 0) {
            setIsVideoReady(true);
          }
        } else {
          cleanupVideoElement(el);
        }
      }
    },
    [cleanupVideoElement, slot.isLocal]
  );

  // Stream replacement updates the existing node without detaching its React ref.
  useLayoutEffect(() => {
    const element = videoElementRef.current;
    if (!element) return;
    if (slot.stream && element.srcObject !== slot.stream) {
      if (!slot.isLocal) setIsVideoReady(false);
      element.srcObject = slot.stream;
      void element.play().catch(() => {});
    } else if (!slot.stream && element.srcObject) {
      cleanupVideoElement(element);
      if (!slot.isLocal) setIsVideoReady(false);
    }
  }, [slot.stream, slot.isLocal, cleanupVideoElement]);

  useEffect(() => {
    return () => {
      if (videoElementRef.current) {
        cleanupVideoElement(videoElementRef.current);
        videoElementRef.current = null;
      }
    };
  }, [cleanupVideoElement]);

  useEffect(() => {
    if (!slot.isLocal && slot.stream) {
      audioContextManager.attachPeerAudio(slot.peerId, slot.stream);
      const st = audioContextManager.getPeerVolumeState(slot.peerId);
      setVolume(st.volume);
      setIsMuted(st.isMuted);
      if (st.volume > 0) setLastVolume(st.volume);
    }
  }, [slot.isLocal, slot.peerId, slot.stream, audioTracksKey, isPipActive]);

  useEffect(() => {
    if (isPipActive) {
      pipService.updateStream(slot.peerId, slot.stream);
    }
  }, [isPipActive, slot.peerId, slot.stream, audioTracksKey]);

  useEffect(() => {
    if (inTray || (!slot.isStreaming && slot.isLocal)) return;

    let isMounted = true;
    const fetchStats = async () => {
      if (!isMounted) return;
      const stats = await roomService.roomManager?.getPeerStats(slot.peerId);
      if (!isMounted) return;
      if (stats?.bitrateKbps !== null && stats?.bitrateKbps !== undefined) {
        setLiveBitrate(stats.bitrateKbps);
      }
      if (stats?.fps !== null && stats?.fps !== undefined) {
        setLiveFps(stats.fps);
      }
      if (stats?.height) {
        setRemoteResolution(`${stats.height}p`);
      }
      if (stats?.pingMs !== null && stats?.pingMs !== undefined) {
        setLivePing(stats.pingMs);
      }
    };

    fetchStats();
    const initialTimer = setTimeout(fetchStats, 600);
    const interval = setInterval(fetchStats, 1500);
    return () => {
      isMounted = false;
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [slot.isLocal, slot.peerId, slot.isStreaming, inTray]);

  const handleCardClick = () => {
    if (pointer.enabled) {
      return;
    }
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    if (zoom > 1.0) {
      return;
    }
    togglePin(slot.peerId);
  };

  const handleStopWatching = (e: React.MouseEvent) => {
    e.stopPropagation();
    stopWatchingStream(slot.peerId);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const val = parseInt(e.target.value, 10);
    setVolume(val);
    setIsMuted(val === 0);
    if (val > 0) setLastVolume(val);
    audioContextManager.setPeerVolume(slot.peerId, val, val === 0);
  };

  const handleToggleMute = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (isMuted || volume === 0) {
      const targetVol = lastVolume || 100;
      setVolume(targetVol);
      setIsMuted(false);
      audioContextManager.setPeerVolume(slot.peerId, targetVol, false);
    } else {
      setLastVolume(volume || 100);
      setVolume(0);
      setIsMuted(true);
      audioContextManager.setPeerVolume(slot.peerId, 0, true);
    }
  };

  const watchers = slot.watchers || [];

  const layoutActions = useRoomCardLayoutActions();
  const handleContextMenu = (event: React.MouseEvent) => {
    const actions: ContextMenuAction[] = [];
    if (layoutMode === 'spotlight' && inTray && !isSelectedFeatured) actions.push({ id: 'overlay', get label() { return t("message.1c2685f76e69"); },
      icon: <PictureInPicture2 size={15} />, onSelect: () => roomService.overlayStream(slot.peerId) });
    if (slot.isLocal && slot.mediaId) actions.push({ id: 'edit', get label() { return t("message.eb9fb0e94a23"); }, icon: <MonitorUp size={15} />,
      onSelect: () => { roomService.editTransmission(slot.mediaId!); openModal('screenPicker'); } });
    if (!isFeatured && !isSelectedFeatured) actions.push({ id: 'feature', get label() { return t("message.b384fe7c4b0e"); }, icon: <Focus size={15} />, onSelect: () => togglePin(slot.peerId) });
    if (layoutMode === 'spotlight') actions.push({ id: 'grid', get label() { return t("message.2e00d3a9b870"); }, icon: <Grid2X2 size={15} />,
      onSelect: returnToGrid });
    if (isPipActive) actions.push({ id: 'restore', get label() { return t("message.5899ac52fbbf"); }, icon: <PictureInPicture2 size={15} />, onSelect: () => pipService.restoreFromPip(slot.peerId) });
    else {
      if (slot.isLocal) actions.push({ id: 'preview', get label() { return showLocalPreview ? t("message.696806b6cddb") : t("message.f281575f257e"); },
        icon: showLocalPreview ? <EyeOff size={15} /> : <Eye size={15} />, onSelect: () => setShowLocalPreview(!showLocalPreview) });
      else actions.push({ id: 'mute', get label() { return isMuted || volume === 0 ? t("message.5cfebda5d336") : t("message.70f507f2963f"); },
        icon: isMuted ? <Volume2 size={15} /> : <VolumeX size={15} />, onSelect: () => handleToggleMute() });
      if (!inTray) {
        actions.push({ id: 'hud', get label() { return isHudPinned ? t("message.6bc8448647e0") : t("message.1572541abe33"); }, icon: <PanelsTopLeft size={15} />, onSelect: () => setIsHudPinned(!isHudPinned) });
        if (zoom > 1) actions.push({ id: 'zoom', get label() { return t("message.2a1c7eafd8bb"); }, icon: <RotateCcw size={15} />, onSelect: resetZoom });
        actions.push({ id: 'fullscreen', get label() { return isFullscreen ? t("message.cbe5019d4a64") : t("message.cdd35dea1ee3"); }, icon: <Maximize size={15} />, onSelect: () => handleToggleFullscreen() });
      }
      actions.push({ id: 'pip', get label() { return t("message.850d2cf3aafa"); }, icon: <PictureInPicture2 size={15} />,
        disabled: !slot.stream, onSelect: () => pipService.openPip(slot.peerId, slot.senderName, slot.stream) });
    }
    actions.push({ id: 'stop', get label() { return slot.isLocal ? t("message.6ef17b51fd93") : t("message.470b862fbd07"); }, icon: <Square size={15} />, separator: true,
      onSelect: slot.isLocal ? () => { if (slot.mediaId) roomService.stopTransmission(slot.mediaId); } : () => stopWatchingStream(slot.peerId) });
    openContextMenu(event, [...actions, ...layoutActions]);
  };

  const pingVal = !slot.isLocal ? (livePing ?? getPeerPing(slot.peerId)) : 0;
  const pingNum = pingVal;
  const pingStr = pingVal !== null && pingVal !== undefined ? `${pingVal} ms` : '-- ms';
  const pingClass = pingNum !== null && pingNum !== undefined
    ? (pingNum < 80 ? 'ping-good' : pingNum < 180 ? 'ping-medium' : 'ping-poor')
    : 'ping-medium';

  const signalingStatus = roomService.roomManager?.getSignalingStatus?.();
  const transportTag = signalingStatus?.activeTransport
    ? ` [${signalingStatus.activeTransport.toUpperCase()}]`
    : '';

  return (
    <div
      ref={cardRef}
      className={`stream-card ${isFeatured ? 'featured' : ''} ${inTray ? 'in-tray' : ''} ${isSelectedFeatured ? 'selected-featured' : ''} ${zoom > 1.0 && !inTray ? 'is-zoomed' : ''} ${isDragging && !inTray ? 'is-dragging' : ''} ${!slot.isLocal && !inTray ? 'has-volume-controller' : ''} ${isHudPinned ? 'is-hud-pinned' : ''} ${activeTooltips > 0 ? 'is-hud-active' : ''} ${pointer.enabled ? 'is-stream-pointer-active' : ''}`}
      data-peer-id={slot.peerId}
      onClick={handleCardClick}
      onContextMenu={handleContextMenu}
      tabIndex={0}
      onMouseDown={!inTray && !pointer.enabled ? handleMouseDown : undefined}
      onDoubleClick={!inTray && !pointer.enabled ? handleDoubleClick : undefined}
    >
      <div
        className="stream-video-viewport"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {inTray && isSelectedFeatured ? (
          <div className="tray-featured-placeholder">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </div>
        ) : isPipActive ? (
          <div className="pip-broadcaster-placeholder local-broadcaster-placeholder">
            <div className="local-broadcaster-radar-pulse">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <rect x="11" y="9" width="9" height="7" rx="1.5"/>
              </svg>
            </div>
            {!inTray && <span className="local-broadcaster-title">{t("message.e78c504525f4")}</span>}
            {!inTray && (
              <span className="local-broadcaster-subtitle">
                {slot.isLocal ? t("message.40628576338c") : t("message.e368e80999d7", { v0: slot.senderName })}
              </span>
            )}
            {!inTray && (
              <button
                type="button"
                className="btn-toggle-local-preview btn-restore-from-pip"
                onClick={(e) => {
                  e.stopPropagation();
                  pipService.restoreFromPip(slot.peerId);
                }}
                aria-label={t("message.3fd671203587")}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20"/>
                  <polyline points="20 10 14 10 14 4"/>
                  <line x1="14" y1="10" x2="21" y2="3"/>
                  <line x1="3" y1="21" x2="10" y2="14"/>
                </svg>
                {t("message.690a35fa4990")}</button>
            )}
          </div>
        ) : slot.isLocal && !showLocalPreview ? (
          <div className="local-broadcaster-placeholder">
            <div className="local-broadcaster-radar-pulse">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
            </div>
            {!inTray && <span className="local-broadcaster-title">{t("message.a6aa3bb90a7e")}</span>}
            {!inTray && (
              <span className="local-broadcaster-subtitle">
                {currentResolution.label} • {formatFrameRate(currentFps)} {t("message.df393af690a7")}</span>
            )}
            {!inTray && (
              <button
                type="button"
                className="btn-toggle-local-preview"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowLocalPreview(true);
                }}
                aria-label={t("message.e41d33bb8cb8")}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
                {t("message.11023c669c46")}</button>
            )}
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              className={`${pointer.enabled ? 'is-stream-pointer-active ' : ''}${pointer.cursorActive ? 'stream-pointer-active-cursor' : ''}`.trim() || undefined}
              autoPlay
              playsInline
              muted
              onLoadedData={() => setIsVideoReady(true)}
              onPlaying={() => setIsVideoReady(true)}
              onTimeUpdate={() => { if (!isVideoReady) setIsVideoReady(true); }}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                imageRendering: '-webkit-optimize-contrast' as any,
                transform: zoom > 1.0 && !inTray ? `translate3d(${pan.x}px, ${pan.y}px, 0px) scale(${zoom})` : 'none',
                transformOrigin: 'center center',
                transition: isDragging ? 'none' : 'transform 0.08s ease-out, opacity 0.2s ease-in',
                willChange: zoom > 1.0 && !inTray ? 'transform' : 'auto',
                opacity: isVideoReady || slot.isLocal ? 1 : 0,
              }}
            />
            {!isVideoReady && !slot.isLocal && (
              <div className="local-broadcaster-placeholder" style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
                <div className="local-broadcaster-radar-pulse">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                    <line x1="8" y1="21" x2="16" y2="21"/>
                    <line x1="12" y1="17" x2="12" y2="21"/>
                  </svg>
                </div>
                {!inTray && <span className="local-broadcaster-title">{t("message.863d929084c6")}</span>}
                {!inTray && <span className="local-broadcaster-subtitle"><Nickname name={slot.senderName} peerId={slot.ownerPeerId ?? slot.peerId} isLocal={slot.isLocal} /></span>}
              </div>
            )}
          </>
        )}
      </div>

      {pointer.indicator}
      {pointer.toolbar}


      {/* Featured badge when in tray */}
      {inTray && isSelectedFeatured && (
        <span className="selected-featured-badge">
          <span className="selected-featured-badge-dot"></span>
        </span>
      )}

      {/* Stats HUD on top of card - only when not in tray and not in PiP */}
      {!inTray && !isPipActive && (
        <StreamStatsOverlay
          qualityText={slot.isLocal ? `${currentResolution.label} ${formatFrameRate(currentFps)} FPS` : `${remoteResolution} ${formatFrameRate(liveFps)} FPS`}
          liveBitrateKbps={liveBitrate}
          configuredBitrateKbps={currentBitrate}
          isLocal={slot.isLocal}
          pingText={pingStr}
          pingClass={pingClass}
          transportTag={transportTag}
          watchers={watchers}
          onTooltipOpenChange={handleTooltipOpenChange}
        />
    )}

      {/* User overlay at bottom-left */}
      <div className="stream-card-overlay">
        <ProfileAvatar peerId={slot.ownerPeerId ?? slot.peerId} name={slot.senderName}
          isLocal={slot.isLocal} color={slot.color} className="stream-profile-avatar" />
        <span className="stream-user-name"><Nickname name={slot.senderName} peerId={slot.ownerPeerId ?? slot.peerId} isLocal={slot.isLocal} />{slot.mediaLabel ? ` · ${slot.mediaLabel}` : ""}</span>
        {slot.isLocal && <span className="badge-you">{t("message.a03099f135b1")}</span>}
      </div>

      {/* Stream stop actions share the tray control recipe. */}
      {((!slot.isLocal && !isPipActive) || (slot.isLocal && (inTray || layoutMode === 'grid'))) && (
        <button
          type="button"
          className="btn-stop-watch-stream"
          onClick={(event) => {
            if (slot.isLocal) { event.stopPropagation(); if (slot.mediaId) void roomService.stopTransmission(slot.mediaId); }
            else handleStopWatching(event);
          }}
          aria-label={slot.isLocal ? t("message.7fd6d14936f2") : t("message.b9a45228925c")}
        >
          {slot.isLocal ? t("message.20321acf4fc8") : t("message.0fdd70d29050")}
        </button>
      )}

      {/* Bottom-right stream controls: Volume (remote only) + PiP + Fullscreen */}
      {!inTray && !isPipActive && (
        <div
          className="stream-controls-group"
          onClick={(e) => e.stopPropagation()}
        >
          {slot.isLocal && showLocalPreview && (
            <button
              type="button"
              className="btn-toggle-local-preview active"
              onClick={(e) => {
                e.stopPropagation();
                setShowLocalPreview(false);
              }}
              aria-label={t("message.317f00cc68bc")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
              {t("message.c94490e9bdea")}</button>
          )}
          {!slot.isLocal && (
            <div className="stream-volume-controller">
              <button
                type="button"
                className="btn-stream-volume"
                onClick={handleToggleMute}
                aria-label={t("message.78ba36d6b04f")}
              >
                {isMuted || volume === 0 ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <line x1="23" x2="17" y1="9" y2="15"/>
                    <line x1="17" x2="23" y1="9" y2="15"/>
                  </svg>
                ) : volume < 50 ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
                  </svg>
                )}
              </button>

              <div className="stream-volume-slider-box">
                <input autoComplete="off"
                  type="range"
                  min="0"
                  max="100"
                  value={isMuted ? 0 : volume}
                  className="stream-volume-range"
                  aria-label={t('message.78ba36d6b04f')}
                  aria-orientation="vertical"
                  onChange={handleVolumeChange}
                  onClick={(e) => e.stopPropagation()}
                />
                <span className="stream-volume-percent">{isMuted ? '0%' : `${volume}%`}</span>
              </div>
            </div>
          )}

          {!slot.isLocal && slot.pointerEligible !== false && <StreamPointerToggle enabled={pointer.enabled} onToggle={pointer.toggle} onTooltipOpenChange={handleTooltipOpenChange} />}

          <Tooltip
            content={
              isHudPinned
                ? t("message.b9125ff913f7")
                : t("message.7dcee91def76")
            }
            onOpenChange={handleTooltipOpenChange}
          >
            <button
              type="button"
              className={`btn-stream-pin ${isHudPinned ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setIsHudPinned((p) => !p);
              }}
              aria-label={
                isHudPinned
                  ? t("message.a66da920f259")
                  : t("message.1efcef298a4c")
              }
            >
              <PanelsTopLeft size={14} aria-hidden="true" />
            </button>
          </Tooltip>

          <Tooltip
            content={t("message.365c67865e1c")}
            onOpenChange={handleTooltipOpenChange}
          >
            <button
              type="button"
              className="btn-stream-pip"
              id={`btn-stream-pip-${slot.peerId}`}
              onClick={(e) => {
                e.stopPropagation();
                pipService.openPip(slot.peerId, slot.senderName, slot.stream);
              }}
              aria-label={t("message.1f626fd80ce4")}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <rect x="11" y="9" width="9" height="7" rx="1.5" fill="currentColor" fillOpacity="0.25" />
              </svg>
            </button>
          </Tooltip>

          <button
            type="button"
            className="btn-stream-fullscreen"
            id={`btn-stream-fullscreen-${slot.peerId}`}
            onClick={handleToggleFullscreen}
            aria-label={isFullscreen ? t("message.1ea619b7211d") : t("message.1dfa15614e9a")}
          >
            {isFullscreen ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 14 10 14 10 20"/>
                <polyline points="20 10 14 10 14 4"/>
                <line x1="14" x2="21" y1="10" y2="3"/>
                <line x1="3" x2="10" y1="21" y2="14"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9"/>
                <polyline points="9 21 3 21 3 15"/>
                <line x1="21" x2="14" y1="3" y2="10"/>
                <line x1="3" x2="10" y1="21" y2="14"/>
              </svg>
            )}
          </button>
        </div>
      )}

      {/* Precision Zoom Control Bar (visible when zoom > 1.0 and not in tray or PiP) */}
      {!inTray && !isPipActive && (
        <ZoomControlBar
          zoom={zoom}
          onZoomChange={setZoomDirect}
          onStepZoom={stepZoomLevel}
          onResetZoom={resetZoom}
          hasVolumeControl={!slot.isLocal}
        />
      )}
      {children}
    </div>
  );
};
