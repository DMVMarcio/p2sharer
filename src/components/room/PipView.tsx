import { localizeText, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useStreamPointer } from '../../hooks/useStreamPointer';
import { streamOwner, formatFrameRate } from '../../core/media_streams';
import { StreamPointerToggle } from './StreamPointerToggle';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { StreamWatcher } from '../../core/types';
import { stateStore } from '../../core/state_store';
import { useStreamZoom } from '../../hooks/useStreamZoom';
import { ZoomControlBar } from './ZoomControlBar';
import { StreamStatsOverlay } from './StreamStatsOverlay';
import { buildIceServers } from '../../p2p/ice_config';
import { initFrontendLogger } from '../../core/logger';
import { Maximize, PanelsTopLeft, Pin, PictureInPicture2, RotateCcw, VolumeX, Volume2 } from 'lucide-react';
import { useContextMenu, type ContextMenuAction } from '../common/ContextMenu';
import { validPipAudioSettings } from '../../services/pip_audio';

interface PipViewProps {
  peerId: string;
}

interface PeerStats {
  pingMs: number | null;
  fps: number;
  bitrateKbps: number;
  height: string;
  watchers: StreamWatcher[];
  configuredBitrateKbps: number;
  transportTag: string;
}

export const PipView: React.FC<PipViewProps> = ({ peerId }) => {
  useLocale();
  const openContextMenu = useContextMenu();
  useEffect(() => {
    initFrontendLogger();
  }, []);

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [senderName, setSenderName] = useState<string>(
    () => new URLSearchParams(window.location.search).get('name') || t("message.15589e9e374d")
  );
  const [isLocal, setIsLocal] = useState<boolean>(streamOwner(peerId) === 'local');
  const [pointerEligible, setPointerEligible] = useState(true);
  const [stats, setStats] = useState<PeerStats>({
    pingMs: null,
    fps: 60,
    bitrateKbps: 0,
    height: '1080p',
    watchers: [],
    configuredBitrateKbps: stateStore.currentBitrate,
    transportTag: '',
  });

  const [volume, setVolume] = useState<number>(100);
  const [isMuted, setIsMuted] = useState<boolean>(isLocal);
  const [lastVolume, setLastVolume] = useState<number>(100);
  const [isHudPinned, setIsHudPinned] = useState<boolean>(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [activeTooltips, setActiveTooltips] = useState<number>(0);

  const handleTooltipOpenChange = useCallback((open: boolean) => {
    setActiveTooltips((previous) => Math.max(0, previous + (open ? 1 : -1)));
  }, []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pointer = useStreamPointer(containerRef, videoRef, peerId, pointerEligible && !isLocal && !!stream && isVideoPlaying, stream, true, pointerEligible && !!stream && isVideoPlaying);
  const streamRef = useRef<MediaStream | null>(null);
  const bcRef = useRef<BroadcastChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const unlistenSignalRef = useRef<UnlistenFn | null>(null);
  const sendSignalRef = useRef<((data: Record<string, unknown>) => void) | null>(null);
  const isVideoPlayingRef = useRef(false);

  const {
    zoom,
    pan,
    isDragging,
    setZoomDirect,
    stepZoomLevel,
    resetZoom,
    handleMouseDown,
    handleDoubleClick,
  } = useStreamZoom(containerRef, stream, true);

  // Set up the loopback WebRTC receiver and signaling on mount.
  useEffect(() => {
    const channelName = `p2sharer-pip-${peerId}`;
    const bc = !isTauri() && typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(channelName)
      : null;
    bcRef.current = bc;

    const iceServers = typeof RTCPeerConnection !== 'undefined' ? buildIceServers() : [];
    const pc = new RTCPeerConnection({ iceServers });
    pcRef.current = pc;

    const pendingCandidates: RTCIceCandidateInit[] = [];
    let hasReceivedOffer = false;

    const sendSignal = (data: Record<string, unknown>) => {
      const payload = { ...data, sender: 'pip' };
      if (isTauri()) {
        emit(`pip-signal-${peerId}`, payload).catch((err) => {
          console.warn('[PipView] Failed to send PiP signal:', err);
        });
      } else {
        try { bc?.postMessage(payload); } catch {}
      }
    };
    sendSignalRef.current = sendSignal;

    pc.ontrack = (event) => {
      setConnectionError(null);
      isVideoPlayingRef.current = false;
      setIsVideoPlaying(false);
      let targetStream = event.streams && event.streams[0];
      if (!targetStream) {
        if (!streamRef.current) {
          streamRef.current = new MediaStream();
        }
        streamRef.current.addTrack(event.track);
        targetStream = streamRef.current;
      } else {
        streamRef.current = targetStream;
      }

      setStream(targetStream);

      if (videoRef.current) {
        if (videoRef.current.srcObject !== targetStream) {
          videoRef.current.srcObject = targetStream;
        }
        videoRef.current.muted = true;
        videoRef.current.play().catch((err) => {
          console.warn('[PipView] Video playback failed:', err);
          setConnectionError(t("message.0dab620e9961"));
        });
      }

      event.track.onunmute = () => {
        if (videoRef.current && videoRef.current.srcObject) {
          videoRef.current.play().catch(() => {});
        }
      };
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: 'candidate',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    const handleSignalData = async (data: Record<string, unknown>) => {
      if (!data || typeof data !== 'object') return;
      if (data.sender === 'pip') return;

      switch (data.type) {
        case 'offer': {
          setPointerEligible(data.pointerEligible !== false);
          hasReceivedOffer = true;
          setConnectionError(null);
          if (data.senderName && typeof data.senderName === 'string') {
            setSenderName(data.senderName);
          }
          if (typeof data.isLocal === 'boolean') {
            setIsLocal(data.isLocal);
            if (data.isLocal) setIsMuted(true);
          }
          if (!data.isLocal && validPipAudioSettings(data.audioSettings)) {
            setVolume(data.audioSettings.volume);
            setIsMuted(data.audioSettings.muted);
            if (data.audioSettings.volume > 0) setLastVolume(data.audioSettings.volume);
          }

          if (data.sdp && typeof data.sdp === 'string') {
            try {
              await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));

              // Drain pending queued ICE candidates
              while (pendingCandidates.length > 0) {
                const cand = pendingCandidates.shift();
                if (cand) {
                  await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
                }
              }

              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);

              sendSignal({
                type: 'answer',
                sdp: answer.sdp,
              });
            } catch (err) {
              console.warn('[PipView] Error handling loopback offer:', err);
            }
          }
          break;
        }
        case 'error': {
          setConnectionError(typeof data.message === 'string' ? data.message : 'Falha na conexão da transmissão.');
          break;
        }
        case 'candidate': {
          if (data.candidate && typeof data.candidate === 'object') {
            const cand = data.candidate as RTCIceCandidateInit;
            try {
              if (pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(cand));
              } else {
                pendingCandidates.push(cand);
              }
            } catch (err) {
              console.warn('[PipView] Error adding candidate:', err);
            }
          }
          break;
        }
        case 'stats': {
          if (data.stats && typeof data.stats === 'object') {
            setStats(data.stats as PeerStats);
          }
          break;
        }
        case 'main-closed': {
          // Main window closed or stream restored; close this window
          try {
            await invoke('close_pip_window', { peerId });
          } catch {
            window.close();
          }
          break;
        }
      }
    };

    // Use one signaling transport at a time; duplicate offers can race WebRTC state.
    if (bc) {
      bc.onmessage = async (event) => {
        await handleSignalData(event.data);
      };
    }

    let disposed = false;
    let retryCount = 0;
    let retryInterval: ReturnType<typeof setInterval> | null = null;
    let requestTimeout: ReturnType<typeof setTimeout> | null = null;

    const requestStream = () => {
      if (disposed) return;
      if (isVideoPlayingRef.current) {
        if (retryInterval) clearInterval(retryInterval);
        retryInterval = null;
        return;
      }
      if (!hasReceivedOffer) {
        sendSignal({ type: 'pip-ready' });
      } else if (retryCount > 0 && retryCount % 6 === 0) {
        sendSignal({ type: 'pip-request-stream' });
      }
    };

    const beginStreamRequests = () => {
      requestStream();
      if (isVideoPlayingRef.current || disposed) return;
      retryInterval = setInterval(() => {
        retryCount++;
        requestStream();
        if (retryCount >= 30 && retryInterval) {
          clearInterval(retryInterval);
          retryInterval = null;
          if (!isVideoPlayingRef.current) {
            setConnectionError(t("message.cb809bc84e15"));
          }
        }
      }, 500);
    };

    const registerSignalListener = async () => {
      if (isTauri()) {
        try {
          const unlisten = await listen<Record<string, unknown>>(`pip-signal-${peerId}`, async (event) => {
            await handleSignalData(event.payload);
          });
          if (disposed) {
            unlisten();
            return;
          }
          unlistenSignalRef.current = unlisten;
        } catch {
          // The browser-only fallback can still use BroadcastChannel.
        }
      }

      if (!disposed) {
        // Strict Mode cleans up its probe effect before this timeout can request an offer.
        requestTimeout = setTimeout(beginStreamRequests, 0);
      }
    };

    void registerSignalListener();

    const disposeSignalSetup = () => {
      disposed = true;
      if (requestTimeout) clearTimeout(requestTimeout);
      if (retryInterval) clearInterval(retryInterval);
      requestTimeout = null;
      retryInterval = null;
    };

    const handleBeforeUnload = () => {
      disposeSignalSetup();
      try {
        sendSignal({ type: 'pip-close' });
      } catch {}
      try {
        pc.close();
      } catch {}
      try {
        bc?.close();
      } catch {}
      if (unlistenSignalRef.current) {
        unlistenSignalRef.current();
        unlistenSignalRef.current = null;
      }
      if (sendSignalRef.current === sendSignal) sendSignalRef.current = null;
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      disposeSignalSetup();
      window.removeEventListener('beforeunload', handleBeforeUnload);
      try {
        pc.close();
      } catch {}
      try {
        bc?.close();
      } catch {}
      if (unlistenSignalRef.current) {
        unlistenSignalRef.current();
        unlistenSignalRef.current = null;
      }
      if (sendSignalRef.current === sendSignal) sendSignalRef.current = null;
    };
  }, [peerId]);

  const handleToggleMute = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (isMuted || volume === 0) {
      const targetVol = lastVolume || 100;
      setVolume(targetVol);
      setIsMuted(false);
      sendSignalRef.current?.({ type: 'audio-settings', volume: targetVol, muted: false });
    } else {
      setLastVolume(volume || 100);
      setVolume(0);
      setIsMuted(true);
      sendSignalRef.current?.({ type: 'audio-settings', volume: 0, muted: true });
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e?.stopPropagation();
    const val = parseInt(e.target.value, 10);
    setVolume(val);
    setIsMuted(val === 0);
    if (val > 0) setLastVolume(val);
    sendSignalRef.current?.({ type: 'audio-settings', volume: val, muted: val === 0 });
  };

  const handleToggleAlwaysOnTop = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const next = !isAlwaysOnTop;
    setIsAlwaysOnTop(next);
    try {
      await invoke('set_pip_always_on_top', {
        peerId,
        alwaysOnTop: next,
      });
    } catch (err) {
      console.warn('[PipView] Failed to set always-on-top via Rust:', err);
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setAlwaysOnTop(next);
      } catch {}
    }
  };

  const handleClose = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      bcRef.current?.postMessage({ type: 'pip-close' });
      emit(`pip-signal-${peerId}`, { type: 'pip-close' }).catch(() => {});
    } catch {}
    try {
      await invoke('close_pip_window', { peerId });
    } catch {
      window.close();
    }
  };

  const handleToggleFullscreen = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (document.fullscreenElement !== containerRef.current) {
      containerRef.current?.requestFullscreen?.().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.().catch(() => {});
      setIsFullscreen(false);
    }
  };

  return (
    <div
      className="pip-window-root"
      ref={containerRef}
      onContextMenu={(event) => {
        const actions: ContextMenuAction[] = [
          { id: 'restore', get label() { return t("message.5899ac52fbbf"); }, icon: <PictureInPicture2 size={15} />, onSelect: () => handleClose() },
          { id: 'top', get label() { return isAlwaysOnTop ? t("message.ceda40d1828b") : t("message.22da96afd9d8"); }, icon: <Pin size={15} />, onSelect: () => handleToggleAlwaysOnTop() },
          { id: 'hud', get label() { return isHudPinned ? t("message.6bc8448647e0") : t("message.1572541abe33"); }, icon: <PanelsTopLeft size={15} />, onSelect: () => setIsHudPinned(!isHudPinned) },
          { id: 'fullscreen', get label() { return isFullscreen ? t("message.cbe5019d4a64") : t("message.cdd35dea1ee3"); }, icon: <Maximize size={15} />, onSelect: () => handleToggleFullscreen() },
        ];
        if (!isLocal) actions.push({ id: 'mute', get label() { return isMuted ? t("message.5cfebda5d336") : t("message.70f507f2963f"); }, icon: isMuted ? <Volume2 size={15} /> : <VolumeX size={15} />, onSelect: () => handleToggleMute() });
        if (zoom > 1) actions.push({ id: 'zoom', get label() { return t("message.2a1c7eafd8bb"); }, icon: <RotateCcw size={15} />, onSelect: resetZoom });
        openContextMenu(event, actions);
      }}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
    >
      {/* Edge-to-edge Video Element */}
      <video
        ref={videoRef}
        className={`pip-video-element${pointer.cursorActive ? ' stream-pointer-active-cursor' : ''}`}
        autoPlay
        playsInline
        muted
        onPlaying={() => {
          isVideoPlayingRef.current = true;
          setIsVideoPlaying(true);
          setConnectionError(null);
        }}
        onWaiting={() => {
          isVideoPlayingRef.current = false;
          setIsVideoPlaying(false);
        }}
        style={{
          transform: zoom > 1.0 ? `scale(${zoom}) translate3d(${pan.x}px, ${pan.y}px, 0)` : 'none',
          cursor: zoom > 1.0 ? (isDragging ? 'grabbing' : 'grab') : 'default',
        }}
      />

      {pointer.indicator}
      {pointer.toolbar}

      {/* Loading state indicator */}
      {!isVideoPlaying && (
        <div className="pip-loading-placeholder">
          {!connectionError && <div className="pip-loading-spinner" />}
          <span>{(connectionError ? localizeText(connectionError) : null) || (stream ? t("message.863d929084c6") : t("message.3bc3a2cd970b"))}</span>
        </div>
      )}

      {/* Floating Hover Overlay - only shown on hover or when HUD is pinned */}
      <div className={`pip-overlay ${isHudPinned || activeTooltips > 0 ? 'is-hud-pinned' : ''}`}>
        {/* Floating Top Bar with data-tauri-drag-region */}
        <div className="pip-top-bar" data-tauri-drag-region>
          <div className="pip-top-left" data-tauri-drag-region>
            <span className="pip-status-dot" aria-hidden="true" />
            <span className="pip-title" data-tauri-drag-region>
              {senderName}
            </span>
          </div>

          <div className="pip-top-right">
            {/* Always on top / Pin toggle */}
            <button
              type="button"
              className={`pip-header-btn ${isAlwaysOnTop ? 'active' : ''}`}
              onClick={handleToggleAlwaysOnTop}
              aria-label={isAlwaysOnTop ? t("message.9edf08040405") : t("message.8826562e878e")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill={isAlwaysOnTop ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="17" x2="12" y2="22" />
                <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
              </svg>
            </button>

            {/* Internal Close 'X' Button */}
            <button
              type="button"
              className="pip-header-btn pip-close-btn"
              onClick={handleClose}
              aria-label={t("message.68392bf40d15")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <StreamStatsOverlay
          className="pip-stream-stats-hud"
          qualityText={`${stats.height} ${formatFrameRate(stats.fps)} FPS`}
          liveBitrateKbps={stats.bitrateKbps}
          configuredBitrateKbps={stats.configuredBitrateKbps}
          isLocal={isLocal}
          pingText={stats.pingMs === null ? '15 ms' : `${stats.pingMs} ms`}
          pingClass={(stats.pingMs ?? 15) < 80 ? 'ping-good' : (stats.pingMs ?? 15) < 180 ? 'ping-medium' : 'ping-poor'}
          transportTag={stats.transportTag}
          watchers={stats.watchers}
          onTooltipOpenChange={handleTooltipOpenChange}
        />

        {/* Hover / Pinned Controls Pill (Bottom-Right) */}
        <div className="stream-controls-group">
          {/* Audio Volume Controller */}
          {!isLocal && (
            <div className={`stream-volume-controller ${isMuted ? 'muted' : ''}`}>
              <button
                type="button"
                className="btn-stream-volume"
                onClick={handleToggleMute}
                aria-label={isMuted ? t("message.d99ff5fe7c0d") : t("message.712929976510")}
              >
                {isMuted || volume === 0 ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="1" y1="1" x2="23" y2="23" />
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                )}
              </button>

              <div className="stream-volume-slider-box">
                <input autoComplete="off"
                  type="range"
                  min="0"
                  max="100"
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="stream-volume-range"
                  aria-label={t("message.c6c6caae0ddf")}
                />
                <span className="stream-volume-percent">{isMuted ? '0%' : `${volume}%`}</span>
              </div>
            </div>
          )}

          {!isLocal && pointerEligible && <StreamPointerToggle enabled={pointer.enabled} onToggle={pointer.toggle} />}

          {/* Pin HUD Button */}
          <button
            type="button"
            className={`btn-stream-pin ${isHudPinned ? 'active' : ''}`}
            onClick={(e) => {
              e?.stopPropagation();
              setIsHudPinned(!isHudPinned);
            }}
            aria-label={isHudPinned ? t("message.36e8a1a8461f") : t("message.e96d2fff8199")}
          >
            <PanelsTopLeft size={14} aria-hidden="true" />
          </button>

          {/* Fullscreen Button */}
          <button
            type="button"
            className={`btn-stream-fullscreen ${isFullscreen ? 'active' : ''}`}
            onClick={handleToggleFullscreen}
            aria-label={isFullscreen ? t("message.1ea619b7211d") : t("message.1dfa15614e9a")}
          >
            {isFullscreen ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              </svg>
            )}
          </button>
        </div>

        {/* Focal Zoom Precision Control Bar (Appears when zoomed > 1.0x) */}
        {zoom > 1.0 && (
          <ZoomControlBar
            zoom={zoom}
            onZoomChange={setZoomDirect}
            onStepZoom={stepZoomLevel}
            onResetZoom={resetZoom}
            hasVolumeControl={!isLocal}
          />
        )}
      </div>
    </div>
  );
};
