import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RoomSlotInfo } from '../../core/types';
import { useRoom } from '../../hooks/useRoom';
import { useStore } from '../../hooks/useStore';
import { useStreamZoom } from '../../hooks/useStreamZoom';
import { audioContextManager } from '../../audio/audio_context_manager';
import { roomService } from '../../services/room_service';
import { ZoomControlBar } from './ZoomControlBar';
import { Tooltip } from '../common/Tooltip';
import { WatchersTooltipContent } from './WatchersTooltipContent';

interface VideoCardProps {
  slot: RoomSlotInfo;
  isFeatured?: boolean;
  inTray?: boolean;
  isSelectedFeatured?: boolean;
}

export const VideoCard: React.FC<VideoCardProps> = ({
  slot,
  isFeatured = false,
  inTray = false,
  isSelectedFeatured = false,
}) => {
  const { togglePin, stopWatchingStream, getPeerPing, username } = useRoom();
  const currentResolution = useStore((s) => s.currentResolution);
  const currentFps = useStore((s) => s.currentFps);
  const currentBitrate = useStore((s) => s.currentBitrate);

  const [liveFps, setLiveFps] = useState<number>(() => (slot.isLocal ? currentFps : 60));
  const [liveBitrate, setLiveBitrate] = useState<number>(0);
  const [remoteResolution, setRemoteResolution] = useState<string>('1080p');

  const [volume, setVolume] = useState<number>(100);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [lastVolume, setLastVolume] = useState<number>(100);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [showLocalPreview, setShowLocalPreview] = useState<boolean>(false);
  const [isHudPinned, setIsHudPinned] = useState<boolean>(false);
  const [activeTooltips, setActiveTooltips] = useState<number>(0);

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

  const handleToggleFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
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
        if (slot.stream) {
          if (el.srcObject !== slot.stream) {
            el.srcObject = slot.stream;
            el.play().catch(() => {});
          } else if (el.paused) {
            el.play().catch(() => {});
          }
        } else {
          cleanupVideoElement(el);
        }
      }
    },
    [slot.stream, cleanupVideoElement]
  );

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
  }, [slot.isLocal, slot.peerId, slot.stream]);

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

  const handleToggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
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
  const watchersCount = watchers.length;

  const pingVal = !slot.isLocal ? getPeerPing(slot.peerId) : 0;
  const pingNum = pingVal ?? 15;
  const pingStr = pingVal !== null && pingVal !== undefined ? `${pingVal} ms` : '15 ms';
  const pingClass = pingNum < 80 ? 'ping-good' : pingNum < 180 ? 'ping-medium' : 'ping-poor';

  const signalingStatus = roomService.roomManager?.getSignalingStatus?.();
  const transportTag = signalingStatus?.activeTransport
    ? ` [${signalingStatus.activeTransport.toUpperCase()}]`
    : '';

  return (
    <div
      ref={cardRef}
      className={`stream-card ${isFeatured ? 'featured' : ''} ${inTray ? 'in-tray' : ''} ${isSelectedFeatured ? 'selected-featured' : ''} ${zoom > 1.0 && !inTray ? 'is-zoomed' : ''} ${isDragging && !inTray ? 'is-dragging' : ''} ${!slot.isLocal && !inTray ? 'has-volume-controller' : ''} ${isHudPinned ? 'is-hud-pinned' : ''} ${activeTooltips > 0 ? 'is-hud-active' : ''}`}
      data-peer-id={slot.peerId}
      onClick={handleCardClick}
      onMouseDown={!inTray ? handleMouseDown : undefined}
      onDoubleClick={!inTray ? handleDoubleClick : undefined}
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
        ) : slot.isLocal && !showLocalPreview ? (
          <div className="local-broadcaster-placeholder">
            <div className="local-broadcaster-radar-pulse">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
            </div>
            {!inTray && <span className="local-broadcaster-title">Você está transmitindo</span>}
            {!inTray && (
              <span className="local-broadcaster-subtitle">
                {currentResolution.label} • {currentFps} FPS • Transmissão Ativa
              </span>
            )}
            {!inTray && (
              <button
                type="button"
                className="btn-toggle-local-preview"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowLocalPreview(true);
                }}
                aria-label="Exibir prévia da sua transmissão"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
                Ver Prévia
              </button>
            )}
          </div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              imageRendering: '-webkit-optimize-contrast' as any,
              transform: zoom > 1.0 && !inTray ? `translate3d(${pan.x}px, ${pan.y}px, 0px) scale(${zoom})` : 'none',
              transformOrigin: 'center center',
              transition: isDragging ? 'none' : 'transform 0.08s ease-out',
              willChange: zoom > 1.0 && !inTray ? 'transform' : 'auto',
            }}
          />
        )}
      </div>

      {/* Featured badge when in tray */}
      {inTray && isSelectedFeatured && (
        <span className="selected-featured-badge">
          <span className="selected-featured-badge-dot"></span>
        </span>
      )}

      {/* Stats HUD on top of card - only when not in tray */}
      {!inTray && (
        <div className="stream-card-stats-hud">
        <span className="stat-badge stat-badge-quality">
          <span className="stat-badge-dot"></span>
          <span className="stat-quality-text">
            {slot.isLocal
              ? `${currentResolution.label} ${currentFps} FPS`
              : `${remoteResolution} ${liveFps} FPS`}
          </span>
        </span>

        {liveBitrate > 0 ? (
          <Tooltip
            tooltipClassName="bitrate-tooltip"
            onOpenChange={handleTooltipOpenChange}
            content={
              <>
                <div className="bitrate-tooltip-header">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                  </svg>
                  <span>{slot.isLocal ? 'Taxa de Envio' : 'Taxa de Recepção'}</span>
                </div>
                <div className="bitrate-tooltip-content">
                  <div className="bitrate-tooltip-row">
                    <span className="bitrate-tooltip-label">Tempo real:</span>
                    <span className="bitrate-tooltip-value">{(liveBitrate / 1000).toFixed(1)} Mbps</span>
                  </div>
                  {slot.isLocal && (
                    <div className="bitrate-tooltip-row">
                      <span className="bitrate-tooltip-label">Limite configurado:</span>
                      <span className="bitrate-tooltip-value">{(currentBitrate / 1000).toFixed(0)} Mbps</span>
                    </div>
                  )}
                </div>
              </>
            }
          >
            <div
              className="stat-badge stat-badge-bitrate"
              onClick={(e) => e.stopPropagation()}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
              </svg>
              <span className="stat-bitrate-text">{(liveBitrate / 1000).toFixed(1)} Mbps</span>
            </div>
          </Tooltip>
        ) : slot.isLocal ? (
          <Tooltip
            tooltipClassName="bitrate-tooltip"
            onOpenChange={handleTooltipOpenChange}
            content={
              <>
                <div className="bitrate-tooltip-header">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                  </svg>
                  <span>Taxa de Envio</span>
                </div>
                <div className="bitrate-tooltip-content">
                  <div className="bitrate-tooltip-row">
                    <span className="bitrate-tooltip-label">Limite configurado:</span>
                    <span className="bitrate-tooltip-value">{(currentBitrate / 1000).toFixed(0)} Mbps</span>
                  </div>
                  <div className="bitrate-tooltip-hint">
                    Aguardando espectadores ou movimento na tela
                  </div>
                </div>
              </>
            }
          >
            <div
              className="stat-badge stat-badge-bitrate"
              onClick={(e) => e.stopPropagation()}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
              </svg>
              <span className="stat-bitrate-text">{(currentBitrate / 1000).toFixed(0)}M máx</span>
            </div>
          </Tooltip>
        ) : (
          <Tooltip
            tooltipClassName="bitrate-tooltip"
            onOpenChange={handleTooltipOpenChange}
            content={
              <>
                <div className="bitrate-tooltip-header">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                  </svg>
                  <span>Taxa de Recepção</span>
                </div>
                <div className="bitrate-tooltip-content">
                  <div className="bitrate-tooltip-row">
                    <span className="bitrate-tooltip-label">Tempo real:</span>
                    <span className="bitrate-tooltip-value">{liveBitrate > 0 ? `${(liveBitrate / 1000).toFixed(1)} Mbps` : '0.0 Mbps'}</span>
                  </div>
                  <div className="bitrate-tooltip-hint">
                    Sincronizando fluxo WebRTC em tempo real
                  </div>
                </div>
              </>
            }
          >
            <div
              className="stat-badge stat-badge-bitrate"
              onClick={(e) => e.stopPropagation()}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
              </svg>
              <span className="stat-bitrate-text">{liveBitrate > 0 ? `${(liveBitrate / 1000).toFixed(1)} Mbps` : '0.0 Mbps'}</span>
            </div>
          </Tooltip>
        )}

        {!slot.isLocal && (
          <span className="stat-badge stat-badge-ping">
            <span className={`stat-ping-dot ${pingClass}`}></span>
            <span className="stat-ping-text">{pingStr}{transportTag}</span>
          </span>
        )}

        <Tooltip
          interactive
          tooltipClassName="watchers-tooltip"
          onOpenChange={handleTooltipOpenChange}
          content={<WatchersTooltipContent watchers={watchers} currentUsername={username} />}
        >
          <div
            className="stat-badge stat-badge-watchers"
            onClick={(e) => e.stopPropagation()}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            <span className="stat-watchers-text">
              {watchersCount === 1 ? '1 assistindo' : `${watchersCount} assistindo`}
            </span>
          </div>
        </Tooltip>
      </div>
    )}

      {/* User overlay at bottom-left */}
      <div className="stream-card-overlay">
        <span className="user-status-dot"></span>
        <span className="stream-user-name">{slot.senderName}</span>
        {slot.isLocal && <span className="badge-you">VOCÊ</span>}
      </div>

      {/* Remote peer controls: Stop Watching */}
      {!slot.isLocal && (
        <button
          className="btn-stop-watch-stream"
          onClick={handleStopWatching}
          aria-label="Parar de assistir esta transmissão"
        >
          Parar de Assistir
        </button>
      )}

      {/* Bottom-right stream controls: Volume (remote only) + Fullscreen */}
      {!inTray && (
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
              aria-label="Ocultar prévia para economizar CPU"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
              Ocultar Prévia
            </button>
          )}
          {!slot.isLocal && (
            <div className="stream-volume-controller">
              <button
                type="button"
                className="btn-stream-volume"
                onClick={handleToggleMute}
                aria-label="Mutar / Desmutar"
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
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={isMuted ? 0 : volume}
                  className="stream-volume-range"
                  onChange={handleVolumeChange}
                  onClick={(e) => e.stopPropagation()}
                />
                <span className="stream-volume-percent">{isMuted ? '0%' : `${volume}%`}</span>
              </div>
            </div>
          )}

          <Tooltip
            content={
              isHudPinned
                ? 'Desafixar interface (ocultar automaticamente)'
                : 'Fixar interface (sempre visível)'
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
                  ? 'Desafixar interface da transmissão'
                  : 'Fixar interface da transmissão'
              }
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill={isHudPinned ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="17" x2="12" y2="22" />
                <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.79-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.79.9A2 2 0 0 0 5 15.24Z" />
              </svg>
            </button>
          </Tooltip>

          <button
            type="button"
            className="btn-stream-fullscreen"
            id={`btn-stream-fullscreen-${slot.peerId}`}
            onClick={handleToggleFullscreen}
            aria-label={isFullscreen ? "Sair da Tela Cheia" : "Tela Cheia"}
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

      {/* Precision Zoom Control Bar (visible when zoom > 1.0 and not in tray) */}
      {!inTray && (
        <ZoomControlBar
          zoom={zoom}
          onZoomChange={setZoomDirect}
          onStepZoom={stepZoomLevel}
          onResetZoom={resetZoom}
          hasVolumeControl={!slot.isLocal}
        />
      )}
    </div>
  );
};
