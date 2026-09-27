import React, { useEffect, useRef, useState } from 'react';
import { useStreamZoom } from '../../hooks/useStreamZoom';
import { ZoomControlBar } from './ZoomControlBar';

interface PipViewProps {
  peerId: string;
}

interface PeerStats {
  pingMs: number | null;
  fps: number;
  bitrateKbps: number;
  height: string;
  watchersCount: number;
}

export const PipView: React.FC<PipViewProps> = ({ peerId }) => {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [senderName, setSenderName] = useState<string>('Transmissão');
  const [isLocal, setIsLocal] = useState<boolean>(peerId === 'local');
  const [stats, setStats] = useState<PeerStats>({
    pingMs: null,
    fps: 60,
    bitrateKbps: 0,
    height: '1080p',
    watchersCount: 0,
  });

  const [volume, setVolume] = useState<number>(100);
  const [isMuted, setIsMuted] = useState<boolean>(isLocal);
  const [lastVolume, setLastVolume] = useState<number>(100);
  const [isHudPinned, setIsHudPinned] = useState<boolean>(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bcRef = useRef<BroadcastChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

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

  // Setup loopback WebRTC receiver & BroadcastChannel on mount
  useEffect(() => {
    const channelName = `p2sharer-pip-${peerId}`;
    const bc = new BroadcastChannel(channelName);
    bcRef.current = bc;

    const pc = new RTCPeerConnection({ iceServers: [] });
    pcRef.current = pc;

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        const remoteStream = event.streams[0];
        setStream(remoteStream);
        if (videoRef.current) {
          videoRef.current.srcObject = remoteStream;
          videoRef.current.play().catch(() => {});
        }
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        bc.postMessage({
          type: 'candidate',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    bc.onmessage = async (event) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      switch (data.type) {
        case 'offer': {
          if (data.senderName) setSenderName(data.senderName);
          if (typeof data.isLocal === 'boolean') {
            setIsLocal(data.isLocal);
            if (data.isLocal) setIsMuted(true);
          }

          if (data.sdp) {
            try {
              await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              bc.postMessage({
                type: 'answer',
                sdp: answer.sdp,
              });
            } catch (err) {
              console.warn('[PipView] Error handling loopback offer:', err);
            }
          }
          break;
        }
        case 'candidate': {
          if (data.candidate) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (err) {
              console.warn('[PipView] Error adding candidate:', err);
            }
          }
          break;
        }
        case 'stats': {
          if (data.stats) {
            setStats(data.stats);
          }
          break;
        }
        case 'main-closed': {
          // Main window closed or stream restored; close this window
          try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            await getCurrentWindow().close();
          } catch {
            window.close();
          }
          break;
        }
      }
    };

    // Tell the main window we are ready to receive the stream offer
    bc.postMessage({ type: 'pip-ready' });

    const handleBeforeUnload = () => {
      try {
        bc.postMessage({ type: 'pip-close' });
      } catch {}
      try {
        pc.close();
      } catch {}
      try {
        bc.close();
      } catch {}
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      handleBeforeUnload();
    };
  }, [peerId]);

  // Sync video element audio volume
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume / 100;
      videoRef.current.muted = isMuted;
    }
  }, [volume, isMuted]);

  const handleToggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isMuted || volume === 0) {
      const targetVol = lastVolume || 100;
      setVolume(targetVol);
      setIsMuted(false);
    } else {
      setLastVolume(volume || 100);
      setVolume(0);
      setIsMuted(true);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const val = parseInt(e.target.value, 10);
    setVolume(val);
    setIsMuted(val === 0);
    if (val > 0) setLastVolume(val);
  };

  const handleToggleAlwaysOnTop = async () => {
    const next = !isAlwaysOnTop;
    setIsAlwaysOnTop(next);
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setAlwaysOnTop(next);
    } catch (err) {
      console.warn('[PipView] Failed to toggle always-on-top:', err);
    }
  };

  const handleClose = async () => {
    try {
      bcRef.current?.postMessage({ type: 'pip-close' });
    } catch {}
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch {
      window.close();
    }
  };

  const handleToggleFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (document.fullscreenElement !== containerRef.current) {
      containerRef.current?.requestFullscreen?.().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.().catch(() => {});
      setIsFullscreen(false);
    }
  };

  const isHudActive = isHudPinned;

  return (
    <div className="pip-window-root" ref={containerRef}>
      {/* Frameless Top Header Bar with data-tauri-drag-region */}
      <header className="pip-header" data-tauri-drag-region>
        <div className="pip-header-left" data-tauri-drag-region>
          <span className="pip-status-dot" aria-hidden="true" />
          <span className="pip-title" data-tauri-drag-region>
            {senderName}
          </span>
          <span className="pip-badge-tag" data-tauri-drag-region>
            PiP
          </span>
        </div>

        <div className="pip-header-right">
          {/* Always on top / Pin toggle */}
          <button
            type="button"
            className={`pip-header-btn ${isAlwaysOnTop ? 'active' : ''}`}
            onClick={handleToggleAlwaysOnTop}
            aria-label={isAlwaysOnTop ? 'Desafixar do topo' : 'Fixar sempre no topo'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="17" x2="12" y2="22" />
              <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
            </svg>
          </button>

          {/* Internal Close 'X' Button */}
          <button
            type="button"
            className="pip-header-btn pip-close-btn"
            onClick={handleClose}
            aria-label="Fechar Picture-in-Picture e voltar ao app"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      {/* Main Video Presentation Body */}
      <div
        className={`pip-video-body ${isHudActive ? 'is-hud-active' : ''} ${isHudPinned ? 'is-hud-pinned' : ''}`}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
      >
        <video
          ref={videoRef}
          className="pip-video-element"
          autoPlay
          playsInline
          muted={isMuted}
          style={{
            transform: zoom > 1.0 ? `scale(${zoom}) translate3d(${pan.x}px, ${pan.y}px, 0)` : 'none',
            cursor: zoom > 1.0 ? (isDragging ? 'grabbing' : 'grab') : 'default',
          }}
        />

        {!stream && (
          <div className="pip-loading-placeholder">
            <div className="pip-loading-spinner" />
            <span>Conectando transmissão...</span>
          </div>
        )}

        {/* Hover / Pinned Stream Stats Badges (Top-Left) */}
        <div className="stream-stats-overlay">
          <div className="stream-stat-badge stat-resolution">
            <span>{stats.height}</span>
          </div>
          <div className="stream-stat-badge stat-fps">
            <span>{stats.fps} FPS</span>
          </div>
          {stats.bitrateKbps > 0 && (
            <div className="stream-stat-badge stat-bitrate">
              <span>
                {stats.bitrateKbps > 1000
                  ? `${(stats.bitrateKbps / 1000).toFixed(1)} Mbps`
                  : `${Math.round(stats.bitrateKbps)} kbps`}
              </span>
            </div>
          )}
        </div>

        {/* Hover / Pinned Controls Pill (Bottom-Right) */}
        <div className="stream-controls-group">
          {/* Audio Volume Controller */}
          {!isLocal && (
            <div className={`stream-volume-controller ${isMuted ? 'muted' : ''}`}>
              <button
                type="button"
                className="btn-stream-volume-toggle"
                onClick={handleToggleMute}
                aria-label={isMuted ? 'Ativar Áudio' : 'Desativar Áudio'}
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
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="stream-volume-range"
                  aria-label="Controle de volume do participante"
                />
              </div>
            </div>
          )}

          {/* Pin HUD Button */}
          <button
            type="button"
            className={`btn-stream-pin ${isHudPinned ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setIsHudPinned(!isHudPinned);
            }}
            aria-label={isHudPinned ? 'Desafixar Controles' : 'Fixar Controles'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="17" x2="12" y2="22" />
              <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
            </svg>
          </button>

          {/* Fullscreen Button */}
          <button
            type="button"
            className={`btn-stream-fullscreen ${isFullscreen ? 'active' : ''}`}
            onClick={handleToggleFullscreen}
            aria-label={isFullscreen ? 'Sair da Tela Cheia' : 'Tela Cheia'}
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
