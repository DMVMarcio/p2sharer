import React, { useEffect, useState } from 'react';
import { useRoom } from '../../hooks/useRoom';
import { useStore } from '../../hooks/useStore';
import { roomService } from '../../services/room_service';

export const StreamHudOverlay: React.FC = () => {
  const { roomSlots, isSharingScreen, pinnedPeerId } = useRoom();
  const currentResolution = useStore((s) => s.currentResolution);
  const currentFps = useStore((s) => s.currentFps);
  const currentBitrate = useStore((s) => s.currentBitrate);

  const [liveFps, setLiveFps] = useState<number>(currentFps);
  const [liveBitrate, setLiveBitrate] = useState<number>(currentBitrate);
  const [livePing, setLivePing] = useState<number | null>(null);
  const [liveWatchersCount, setLiveWatchersCount] = useState<number>(0);
  const [activeTransport, setActiveTransport] = useState<string>('');

  const streamingSlots = roomSlots.filter((s) => s.isStreaming);
  const hasStreams = streamingSlots.length > 0;

  useEffect(() => {
    if (!hasStreams) return;

    const interval = setInterval(async () => {
      const sig = roomService.roomManager?.getSignalingStatus();
      if (sig?.activeTransport) {
        setActiveTransport(sig.activeTransport.toUpperCase());
      }

      // Check featured slot or local slot or first stream
      const targetPeerId = pinnedPeerId || (isSharingScreen ? 'local' : streamingSlots[0]?.peerId);
      if (!targetPeerId) return;

      const isTargetLocal = targetPeerId === 'local';
      if (isTargetLocal) {
        setLiveFps(currentFps);
        setLiveBitrate(currentBitrate);
        setLivePing(0);
        const watchers = roomService.roomManager?.getStreamWatchers('local') || [];
        setLiveWatchersCount(watchers.length);
      } else {
        const stats = await roomService.roomManager?.getPeerStats(targetPeerId);
        const ping = stats?.pingMs ?? roomService.roomManager?.getPeerPing(targetPeerId) ?? null;
        setLivePing(ping);
        if (stats?.fps) setLiveFps(stats.fps);
        if (stats?.bitrateKbps) setLiveBitrate(stats.bitrateKbps);
        const watchers = roomService.roomManager?.getStreamWatchers(targetPeerId) || [];
        setLiveWatchersCount(watchers.length);
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [hasStreams, pinnedPeerId, isSharingScreen, currentFps, currentBitrate, streamingSlots]);

  if (!hasStreams) return null;

  const transportSuffix = activeTransport ? ` [${activeTransport}]` : '';
  const pingDisplay = isSharingScreen
    ? `0 ms (Local)${transportSuffix}`
    : livePing !== null
    ? `${livePing} ms${transportSuffix}`
    : `15 ms${transportSuffix}`;

  return (
    <div className="stream-hud-overlay" id="stream-hud-overlay" style={{ display: 'block' }}>
      <div className="hud-pill" id="hud-quality-pill">
        <span className="hud-dot"></span>
        <span id="hud-res-fps-text">
          {currentResolution.label} {liveFps} FPS
        </span>
        <span className="hud-divider">|</span>
        <span id="hud-bitrate-text">{(liveBitrate / 1000).toFixed(1)} Mbps</span>
        <span className="hud-divider">|</span>
        <span id="hud-ping-text" title="Latência WebRTC">
          {pingDisplay}
        </span>
        <span className="hud-divider">|</span>
        <span id="hud-watchers-text" title="Espectadores assistindo esta tela">
          👁️ {liveWatchersCount}
        </span>
      </div>
    </div>
  );
};
