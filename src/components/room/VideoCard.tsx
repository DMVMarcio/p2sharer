import React, { useCallback, useEffect, useState } from 'react';
import { RoomSlotInfo } from '../../core/types';
import { useRoom } from '../../hooks/useRoom';
import { useStore } from '../../hooks/useStore';
import { audioContextManager } from '../../audio/audio_context_manager';
import { roomService } from '../../services/room_service';

interface VideoCardProps {
  slot: RoomSlotInfo;
  isFeatured?: boolean;
}

export const VideoCard: React.FC<VideoCardProps> = ({ slot, isFeatured = false }) => {
  const { togglePin, stopWatchingStream, getPeerPing, username } = useRoom();
  const currentResolution = useStore((s) => s.currentResolution);
  const currentFps = useStore((s) => s.currentFps);
  const currentBitrate = useStore((s) => s.currentBitrate);

  const [liveFps, setLiveFps] = useState<number>(() => (slot.isLocal ? currentFps : 60));
  const [liveBitrate, setLiveBitrate] = useState<number>(() => (slot.isLocal ? currentBitrate : 0));
  const [remoteResolution, setRemoteResolution] = useState<string>('1080p');

  const [volume, setVolume] = useState<number>(100);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [lastVolume, setLastVolume] = useState<number>(100);

  const videoRef = useCallback(
    (el: HTMLVideoElement | null) => {
      if (el && slot.stream) {
        if (el.srcObject !== slot.stream) {
          el.srcObject = slot.stream;
          el.play().catch(() => {});
        } else if (el.paused) {
          el.play().catch(() => {});
        }
      }
    },
    [slot.stream]
  );

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
    if (slot.isLocal) {
      setLiveBitrate(currentBitrate);
      setLiveFps(currentFps);
      return;
    }

    let isMounted = true;
    const fetchStats = async () => {
      const stats = await roomService.roomManager?.getPeerStats(slot.peerId);
      if (!isMounted) return;
      if (stats?.bitrateKbps) setLiveBitrate(stats.bitrateKbps);
      if (stats?.fps) setLiveFps(stats.fps);
      if (stats?.height) {
        setRemoteResolution(`${stats.height}p`);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 2000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [slot.isLocal, slot.peerId, currentBitrate, currentFps]);

  const handleCardClick = () => {
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

  const getTitle = () => {
    if (isFeatured) return 'Clique para voltar à grade';
    if (slot.isLocal) return 'Clique para destacar sua transmissão';
    return 'Clique para destacar esta transmissão';
  };

  return (
    <div
      className={`stream-card ${isFeatured ? 'featured' : ''}`}
      data-peer-id={slot.peerId}
      title={getTitle()}
      onClick={handleCardClick}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      />

      {/* Stats HUD on top of card */}
      <div className="stream-card-stats-hud">
        <span className="stat-badge stat-badge-quality">
          <span className="stat-badge-dot"></span>
          <span className="stat-quality-text">
            {slot.isLocal
              ? `${currentResolution.label} ${currentFps} FPS`
              : `${remoteResolution} ${liveFps} FPS`}
          </span>
        </span>

        {liveBitrate > 0 && (
          <span className="stat-badge stat-badge-bitrate">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <span className="stat-bitrate-text">{(liveBitrate / 1000).toFixed(1)} Mbps</span>
          </span>
        )}

        {!slot.isLocal && (
          <span className="stat-badge stat-badge-ping">
            <span className={`stat-ping-dot ${pingClass}`}></span>
            <span className="stat-ping-text">{pingStr}{transportTag}</span>
          </span>
        )}

        <div
          className="stat-badge stat-badge-watchers custom-tooltip-container"
          onClick={(e) => e.stopPropagation()}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          <span className="stat-watchers-text">
            {watchersCount === 1 ? '1 assistindo' : `${watchersCount} assistindo`}
          </span>

          <div className="custom-tooltip watchers-tooltip">
            <div className="watchers-tooltip-header">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              <span>
                {watchersCount === 0
                  ? 'Ninguém assistindo'
                  : watchersCount === 1
                  ? '1 pessoa assistindo:'
                  : `${watchersCount} pessoas assistindo:`}
              </span>
            </div>
            {watchersCount > 0 ? (
              <div className="watchers-tooltip-list">
                {watchers.map((w) => {
                  const isSelf = w.username === username;
                  return (
                    <div key={w.peerId} className="watchers-tooltip-item">
                      <span className="watchers-tooltip-dot"></span>
                      <span className="watchers-tooltip-name">{w.username}</span>
                      {isSelf && <span className="badge-you">VOCÊ</span>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="watchers-tooltip-empty">Nenhum espectador no momento</div>
            )}
          </div>
        </div>
      </div>

      {/* User overlay at bottom-left */}
      <div className="stream-card-overlay">
        <span className="user-status-dot"></span>
        <span className="stream-user-name">{slot.senderName}</span>
        {slot.isLocal && <span className="badge-you">VOCÊ</span>}
      </div>

      {/* Remote peer controls: Stop Watching and Volume */}
      {!slot.isLocal && (
        <>
          <button
            className="btn-stop-watch-stream"
            title="Parar de assistir esta transmissão"
            onClick={handleStopWatching}
          >
            Parar de Assistir
          </button>

          <div
            className="stream-volume-controller"
            title="Controle de Volume da Transmissão"
            onClick={(e) => e.stopPropagation()}
          >
            <button className="btn-stream-volume" title="Mutar / Desmutar" onClick={handleToggleMute}>
              {isMuted || volume === 0 ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                  <line x1="23" x2="17" y1="9" y2="15"/>
                  <line x1="17" x2="23" y1="9" y2="15"/>
                </svg>
              ) : volume < 50 ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
        </>
      )}
    </div>
  );
};
