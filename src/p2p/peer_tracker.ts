import type { PeerInfo, StreamWatcher } from '../core/types.ts';

export interface PeerExchangeEntry {
  peerId: string;
  username: string;
  isStreaming?: boolean;
  isCreator?: boolean;
  joinedAt?: number;
}

/**
 * PeerTracker provides verified WebRTC peer tracking for P2Sharer rooms.
 * It strictly separates direct WebRTC connected peers from unverified PEX rumors,
 * preventing ghost peer cards from appearing in the UI and ensuring deterministic
 * host election and immediate cleanup on disconnects.
 */
export class PeerTracker {
  // Verified direct WebRTC peers
  public directConnectedPeers: Set<string> = new Set();
  // Unverified gossip rumors from PEX (isolated until direct WebRTC connects)
  public unverifiedRumors: Set<string> = new Set();

  private peers = new Map<string, string>(); // peerId -> username (only verified peers)
  private peerLastSeen = new Map<string, number>(); // peerId -> timestamp
  private peerJoinedAt = new Map<string, number>(); // peerId -> timestamp
  private peerIsCreator = new Map<string, boolean>(); // peerId -> isCreator
  private peerPings = new Map<string, number>(); // peerId -> ping in ms
  private streamWatchers = new Map<string, Set<string>>(); // broadcasterId -> Set<watcherPeerId>
  private watcherNames = new Map<string, string>(); // peerId -> username
  private streamingPeers = new Set<string>(); // verified peerId set who is broadcasting

  /**
   * Processes a peer arrival from direct WebRTC connection or PEX gossip.
   * Direct connections are verified and tracked immediately.
   * PEX gossip rumors are quarantined in unverifiedRumors until WebRTC pairs.
   *
   * @returns true if the peer is verified/direct; false if quarantined as rumor.
   */
  public receivePeerExchange(
    peerId: string,
    isDirectWebRtc: boolean,
    username?: string,
    isCreator = false,
    joinedAt = Date.now()
  ): boolean {
    if (!peerId) return false;

    if (isDirectWebRtc) {
      this.directConnectedPeers.add(peerId);
      this.unverifiedRumors.delete(peerId);

      const resolvedName =
        username?.trim() ||
        this.peers.get(peerId) ||
        this.watcherNames.get(peerId) ||
        `Participante (${peerId.slice(0, 4)})`;
      this.peers.set(peerId, resolvedName);
      this.peerLastSeen.set(peerId, Date.now());

      if (!this.peerJoinedAt.has(peerId)) {
        this.peerJoinedAt.set(peerId, joinedAt);
      }
      this.peerIsCreator.set(peerId, isCreator);
      return true;
    } else {
      // Unverified PEX rumor - do not accept as connected peer until WebRTC connects
      if (!this.directConnectedPeers.has(peerId)) {
        this.unverifiedRumors.add(peerId);
        if (username?.trim()) {
          this.watcherNames.set(peerId, username.trim());
        }
      }
      return false;
    }
  }

  /**
   * Returns list of currently quarantined, unverified peer rumors.
   */
  public getPendingRumors(): string[] {
    return Array.from(this.unverifiedRumors);
  }

  public getRumorUsername(peerId: string): string | undefined {
    return this.watcherNames.get(peerId);
  }

  /**
   * Directly adds and verifies a connected peer (e.g. from onPeerJoin).
   */
  public addPeer(peerId: string, username: string, isCreator = false, joinedAt = Date.now()): void {
    this.receivePeerExchange(peerId, true, username, isCreator, joinedAt);
  }

  /**
   * Handles peer disconnection or explicit leave.
   * Completely purges the peer from verified peers, rumors, watchers, and ping states,
   * guaranteeing zero ghost cards in the UI.
   */
  public peerDisconnected(peerId: string): string | undefined {
    const username = this.peers.get(peerId);

    this.directConnectedPeers.delete(peerId);
    this.unverifiedRumors.delete(peerId);
    this.peers.delete(peerId);
    this.peerLastSeen.delete(peerId);
    this.peerJoinedAt.delete(peerId);
    this.peerIsCreator.delete(peerId);
    this.peerPings.delete(peerId);
    this.watcherNames.delete(peerId);
    this.streamingPeers.delete(peerId);

    // Remove as watcher from all active stream slots
    this.streamWatchers.forEach((watchers) => {
      watchers.delete(peerId);
    });
    // Remove their own broadcast watchers list
    this.streamWatchers.delete(peerId);

    return username;
  }

  /**
   * Alias for peerDisconnected.
   */
  public removePeer(peerId: string): string | undefined {
    return this.peerDisconnected(peerId);
  }

  /**
   * Updates last-seen timestamp for an active verified peer.
   */
  public touchPeer(peerId: string): void {
    if (this.directConnectedPeers.has(peerId)) {
      this.peerLastSeen.set(peerId, Date.now());
    }
  }

  public getUsername(peerId: string): string | undefined {
    return this.peers.get(peerId);
  }

  public hasPeer(peerId: string): boolean {
    return this.directConnectedPeers.has(peerId) && this.peers.has(peerId);
  }

  public isVerified(peerId: string): boolean {
    return this.directConnectedPeers.has(peerId);
  }

  public setStreaming(peerId: string, isStreaming: boolean): void {
    if (isStreaming) {
      this.streamingPeers.add(peerId);
    } else {
      this.streamingPeers.delete(peerId);
    }
  }

  public isStreaming(peerId: string): boolean {
    return this.streamingPeers.has(peerId);
  }

  public setPing(peerId: string, pingMs: number): void {
    if (this.directConnectedPeers.has(peerId)) {
      this.peerPings.set(peerId, pingMs);
    }
  }

  public getPing(peerId: string): number | undefined {
    return this.peerPings.get(peerId);
  }

  public addWatcher(broadcasterId: string, watcherId: string, watcherName: string): void {
    if (!this.streamWatchers.has(broadcasterId)) {
      this.streamWatchers.set(broadcasterId, new Set());
    }
    this.streamWatchers.get(broadcasterId)!.add(watcherId);
    this.watcherNames.set(watcherId, watcherName);
  }

  public removeWatcher(broadcasterId: string, watcherId: string): void {
    const watchers = this.streamWatchers.get(broadcasterId);
    if (watchers) {
      watchers.delete(watcherId);
      if (watchers.size === 0) {
        this.streamWatchers.delete(broadcasterId);
      }
    }
  }

  public getWatchers(broadcasterId: string): StreamWatcher[] {
    const watchers = this.streamWatchers.get(broadcasterId);
    if (!watchers) return [];
    return Array.from(watchers).map((id) => ({
      peerId: id,
      username: this.watcherNames.get(id) || this.peers.get(id) || 'Usuário',
    }));
  }

  /**
   * Returns list of verified direct WebRTC peers ONLY.
   * Excludes all unverified PEX rumors.
   */
  public getVerifiedPeers(): PeerInfo[] {
    const list: PeerInfo[] = [];
    this.directConnectedPeers.forEach((pId) => {
      const uname = this.peers.get(pId) || `Participante (${pId.slice(0, 4)})`;
      list.push({
        id: pId,
        username: uname,
        connectionState: 'connected',
        joinedAt: this.peerJoinedAt.get(pId) || Date.now(),
      });
    });
    return list;
  }

  /**
   * Prunes peers that have not sent heartbeats or pings within timeoutMs.
   * Returns array of pruned peerIds.
   */
  public pruneStalePeers(timeoutMs = 6000): string[] {
    const now = Date.now();
    const stale: string[] = [];
    this.directConnectedPeers.forEach((peerId) => {
      const lastSeen = this.peerLastSeen.get(peerId) || 0;
      if (now - lastSeen > timeoutMs) {
        stale.push(peerId);
      }
    });

    stale.forEach((peerId) => {
      this.peerDisconnected(peerId);
    });

    return stale;
  }

  /**
   * Deterministic host election:
   * 1. If local user is creator -> returns true.
   * 2. If any verified peer is creator -> returns false.
   * 3. Lowest joinedAt timestamp, with tie-break on lexicographically lowest peerId.
   */
  public isHost(selfId: string, myJoinedAt: number, isCreator: boolean): boolean {
    if (isCreator) return true;

    // Check if creator is present among verified peers
    let hasCreatorPeer = false;
    this.directConnectedPeers.forEach((pId) => {
      if (this.peerIsCreator.get(pId)) {
        hasCreatorPeer = true;
      }
    });
    if (hasCreatorPeer) return false;

    let oldestPeerId = selfId;
    let oldestJoin = myJoinedAt;

    this.directConnectedPeers.forEach((pId) => {
      const joinTime = this.peerJoinedAt.get(pId) || Date.now();
      if (joinTime < oldestJoin || (joinTime === oldestJoin && pId < oldestPeerId)) {
        oldestJoin = joinTime;
        oldestPeerId = pId;
      }
    });

    return oldestPeerId === selfId;
  }

  public getJoinedAt(peerId: string): number | undefined {
    return this.peerJoinedAt.get(peerId);
  }

  public isPeerCreator(peerId: string): boolean {
    return Boolean(this.peerIsCreator.get(peerId));
  }

  public clear(): void {
    this.directConnectedPeers.clear();
    this.unverifiedRumors.clear();
    this.peers.clear();
    this.peerLastSeen.clear();
    this.peerJoinedAt.clear();
    this.peerIsCreator.clear();
    this.peerPings.clear();
    this.streamWatchers.clear();
    this.watcherNames.clear();
    this.streamingPeers.clear();
  }
}
