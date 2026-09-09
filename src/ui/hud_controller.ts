import { stateStore } from '../core/state_store.ts';
import type { PeerStatsInfo, SignalingStatus, StreamWatcher } from '../core/types.ts';

export interface HudStatsProvider {
  getPeerStats: (peerId: string) => Promise<PeerStatsInfo | null | undefined>;
  getPeerPing: (peerId: string) => number | null | undefined;
  getStreamWatchers: (peerId: string) => StreamWatcher[];
  getSignalingStatus?: () => SignalingStatus | null | undefined;
}

export class HudController {
  private liveStatsTimer: ReturnType<typeof setInterval> | null = null;
  private provider: HudStatsProvider | null = null;

  public start(provider: HudStatsProvider): void {
    this.provider = provider;
    this.stop();
    this.liveStatsTimer = setInterval(async () => {
      await this.updateLiveStreamStats();
    }, 1500);
    setTimeout(() => this.updateLiveStreamStats(), 200);
  }

  public stop(): void {
    if (this.liveStatsTimer) {
      clearInterval(this.liveStatsTimer);
      this.liveStatsTimer = null;
    }
    const hud = document.getElementById('stream-hud-overlay');
    if (hud) hud.style.display = 'none';
  }

  public async updateLiveStreamStats(): Promise<void> {
    if (!this.provider) return;

    const streamCards = document.querySelectorAll<HTMLElement>('.stream-card');
    if (streamCards.length === 0) {
      const hud = document.getElementById('stream-hud-overlay');
      if (hud) hud.style.display = 'none';
      return;
    }

    const signalingStatus = this.provider.getSignalingStatus?.() || null;
    const transportLabel = signalingStatus ? ` [${signalingStatus.activeTransport.toUpperCase()}]` : '';

    for (const card of Array.from(streamCards)) {
      const peerId = card.getAttribute('data-peer-id');
      if (!peerId) continue;

      const video = card.querySelector('video');
      const qualityEl = card.querySelector('.stat-quality-text');
      const pingEl = card.querySelector('.stat-ping-text');
      const pingDot = card.querySelector('.stat-ping-dot');
      const watchersEl = card.querySelector('.stat-watchers-text');
      const isLocal = peerId === 'local';

      let qualityLabel = isLocal ? stateStore.currentResolution.label : '1080p';
      if (video && video.videoHeight > 0) {
        const h = video.videoHeight;
        if (h >= 2000) qualityLabel = '4K';
        else if (h >= 1400) qualityLabel = '1440p';
        else if (h >= 1000) qualityLabel = '1080p';
        else if (h >= 700) qualityLabel = '720p';
        else if (h >= 450) qualityLabel = '480p';
        else if (h >= 300) qualityLabel = '360p';
        else qualityLabel = `${h}p`;
      }

      const stats = isLocal ? null : await this.provider.getPeerStats(peerId);
      const fps = stats?.fps ?? (isLocal ? stateStore.currentFps : video && video.videoHeight > 0 ? 60 : 30);
      const ping = isLocal ? 0 : (stats?.pingMs ?? this.provider.getPeerPing(peerId) ?? null);

      if (qualityEl) {
        qualityEl.textContent = `${qualityLabel} ${fps} FPS`;
      }

      if (pingEl) {
        if (isLocal) {
          pingEl.textContent = `Local${transportLabel}`;
        } else {
          pingEl.textContent = ping !== null ? `${ping} ms${transportLabel}` : `-- ms${transportLabel}`;
          if (pingDot && ping !== null) {
            pingDot.className = `stat-ping-dot ${
              ping < 80 ? 'ping-good' : ping < 180 ? 'ping-medium' : 'ping-poor'
            }`;
          }
        }
      }

      const watchers = this.provider.getStreamWatchers(peerId);
      const count = watchers.length;
      if (watchersEl) {
        watchersEl.textContent = count === 1 ? '1 assistindo' : `${count} assistindo`;
        const tooltip =
          count > 0
            ? `Assistindo: ${watchers.map((w) => w.username).join(', ')}`
            : 'Ninguém assistindo no momento';
        watchersEl.parentElement?.setAttribute('title', tooltip);
      }

      if (card.classList.contains('featured') || streamCards.length === 1) {
        const hud = document.getElementById('stream-hud-overlay');
        const resFpsText = document.getElementById('hud-res-fps-text');
        const bitrateText = document.getElementById('hud-bitrate-text');
        const pingTextEl = document.getElementById('hud-ping-text');
        const watchersTextEl = document.getElementById('hud-watchers-text');

        if (hud) hud.style.display = 'block';
        if (resFpsText) resFpsText.textContent = `${qualityLabel} ${fps} FPS`;
        if (bitrateText) {
          const bitrateVal = stats?.bitrateKbps
            ? (stats.bitrateKbps / 1000).toFixed(1)
            : (stateStore.currentBitrate / 1000).toFixed(1);
          bitrateText.textContent = `${bitrateVal} Mbps`;
        }
        if (pingTextEl) {
          pingTextEl.textContent = isLocal
            ? `0 ms (Local)${transportLabel}`
            : ping !== null
            ? `${ping} ms${transportLabel}`
            : `-- ms${transportLabel}`;
          if (signalingStatus) {
            pingTextEl.setAttribute(
              'title',
              `Sinalização Ativa: ${signalingStatus.activeTransport.toUpperCase()} (Peers: ${
                signalingStatus.connectedPeers.length
              })`
            );
          }
        }
        if (watchersTextEl) {
          watchersTextEl.textContent = `👁️ ${count} assistindo`;
          const tooltip = count > 0 ? `Assistindo: ${watchers.map((w) => w.username).join(', ')}` : 'Nenhum espectador';
          watchersTextEl.setAttribute('title', tooltip);
        }
      }
    }
  }

  public updateStatsHUD(): void {
    const hud = document.getElementById('stream-hud-overlay');
    const resFpsText = document.getElementById('hud-res-fps-text');
    const bitrateText = document.getElementById('hud-bitrate-text');
    const pingTextEl = document.getElementById('hud-ping-text');
    const watchersTextEl = document.getElementById('hud-watchers-text');

    if (!hud) return;

    const streamingSlots = stateStore.roomSlots.filter((s) => s.isStreaming);
    if (streamingSlots.length === 0) {
      hud.style.display = 'none';
      return;
    }

    const signalingStatus = this.provider?.getSignalingStatus?.() || null;
    const transportLabel = signalingStatus ? ` [${signalingStatus.activeTransport.toUpperCase()}]` : '';

    hud.style.display = 'block';
    if (resFpsText) resFpsText.textContent = `${stateStore.currentResolution.label} ${stateStore.currentFps} FPS`;
    if (bitrateText) bitrateText.textContent = `${(stateStore.currentBitrate / 1000).toFixed(1)} Mbps`;
    if (pingTextEl) {
      pingTextEl.textContent = stateStore.isSharingScreen
        ? `0 ms (Local)${transportLabel}`
        : `15 ms${transportLabel}`;
    }
    if (watchersTextEl && this.provider) {
      const localWatchers = this.provider.getStreamWatchers('local');
      watchersTextEl.textContent = `👁️ ${localWatchers.length} assistindo`;
    }
  }

  public showIceDiagnosticAlert(message: string): void {
    const badge = document.getElementById('room-stats-badge');
    if (badge) {
      badge.textContent = message;
      badge.classList.add('badge-warning');
      setTimeout(() => {
        badge.classList.remove('badge-warning');
      }, 5000);
    }
  }
}
