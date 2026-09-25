import type { PeerStatsInfo, SignalingStatus, StreamWatcher } from '../core/types.ts';

export interface HudStatsProvider {
  getPeerStats: (peerId: string) => Promise<PeerStatsInfo | null | undefined>;
  getPeerPing: (peerId: string) => number | null | undefined;
  getStreamWatchers: (peerId: string) => StreamWatcher[];
  getSignalingStatus?: () => SignalingStatus | null | undefined;
}

export class HudController {
  public start(_provider: HudStatsProvider): void {
    // Deprecated in React migration - stream stats HUD is managed declaratively by VideoCard
  }

  public stop(): void {
    // Deprecated in React migration
  }

  public async updateLiveStreamStats(): Promise<void> {
    // No-op: React VideoCard component owns card stats HUD declaratively
  }

  public updateStatsHUD(): void {
    // No-op: StreamHudOverlay has been decommissioned and consolidated into VideoCard HUD
  }

  public showIceDiagnosticAlert(_message: string): void {
    // Diagnostic badge messages are handled via showToast / React state
  }
}

