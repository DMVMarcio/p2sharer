/**
 * Authoritative Signaling & Room State Machine Oracle
 * Implements reference models for room ID hashing, slug generation, user coloring,
 * and multi-transport failover state machines.
 */

import { createHash } from 'node:crypto';
import type { SignalingTransport, SignalingStatus } from './types.ts';

export const ADJECTIVES = [
  'cyber', 'neon', 'rapid', 'swift', 'cosmic', 'hyper', 'solar', 'lunar',
  'mystic', 'sonic', 'ultra', 'mega', 'royal', 'epic', 'prime', 'iron',
  'silver', 'golden', 'shadow', 'crystal', 'astro', 'blaze', 'storm', 'vortex',
  'quantum', 'echo', 'alpha', 'nova', 'turbo', 'ninja', 'pixel', 'phantom'
];

export const NOUNS = [
  'falcon', 'tiger', 'wolf', 'eagle', 'hawk', 'panther', 'fox', 'dragon',
  'phoenix', 'bear', 'shark', 'cobra', 'viper', 'lion', 'lynx', 'titan',
  'nomad', 'runner', 'driver', 'spark', 'storm', 'pulse', 'byte', 'core',
  'matrix', 'drift', 'horizon', 'forge', 'nexus', 'rover', 'shield', 'vortex'
];

/**
 * Derives the signaling room ID from a room name and optional password.
 * Public rooms: 'public-${cleanRoom}'
 * Password rooms: 'sec-${cleanRoom}-${sha256Hex(16)}'
 */
export function computeSignalingRoomIdOracle(roomId: string, password = ''): string {
  const cleanRoom = roomId.trim().toLowerCase();
  const cleanPass = password.trim();
  if (!cleanPass) {
    return `public-${cleanRoom}`;
  }
  const input = `p2sharer-auth:${cleanRoom}:${cleanPass}`;
  const hashHex = createHash('sha256').update(input).digest('hex').substring(0, 16);
  return `sec-${cleanRoom}-${hashHex}`;
}

/**
 * Validates whether a room slug follows the standard pattern: adj-noun-num (100-999)
 */
export function validateRoomSlugFormat(slug: string): boolean {
  const parts = slug.split('-');
  if (parts.length !== 3) return false;
  const [adj, noun, numStr] = parts;
  if (!adj || !noun || !numStr) return false;
  if (!ADJECTIVES.includes(adj)) return false;
  if (!NOUNS.includes(noun)) return false;
  const num = Number(numStr);
  return !isNaN(num) && num >= 100 && num <= 999;
}

/**
 * Deterministically generates an HSL color from a user name.
 */
export function generateUserColorOracle(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 65%, 45%)`;
}

export type TransportState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'STALLED' | 'FAILING_OVER' | 'CLOSED';

export class SignalingFailoverMachine {
  public currentTransport: SignalingTransport = 'mqtt';
  public availableTransports: SignalingTransport[] = ['mqtt', 'nostr', 'torrent'];
  public state: TransportState = 'IDLE';
  public directConnectedPeers: Set<string> = new Set();
  public unverifiedRumors: Set<string> = new Set();
  public failoverHistory: Array<{ from: SignalingTransport; to: SignalingTransport; timestamp: number }> = [];

  public connect(transport: SignalingTransport = 'mqtt'): void {
    this.currentTransport = transport;
    this.state = 'CONNECTED';
  }

  public recordWatchdogFailure(): SignalingTransport {
    this.state = 'STALLED';
    const currentIdx = this.availableTransports.indexOf(this.currentTransport);
    const nextIdx = (currentIdx + 1) % this.availableTransports.length;
    const nextTransport = this.availableTransports[nextIdx]!;
    
    this.failoverHistory.push({
      from: this.currentTransport,
      to: nextTransport,
      timestamp: Date.now(),
    });

    this.currentTransport = nextTransport;
    this.state = 'CONNECTED';
    return nextTransport;
  }

  public receivePeerExchange(peerId: string, isDirectWebRtc: boolean): boolean {
    if (isDirectWebRtc) {
      this.directConnectedPeers.add(peerId);
      this.unverifiedRumors.delete(peerId);
      return true; // Verified direct peer
    } else {
      // PEX rumor - do not accept as connected peer until WebRTC connects
      if (!this.directConnectedPeers.has(peerId)) {
        this.unverifiedRumors.add(peerId);
      }
      return false;
    }
  }

  public peerDisconnected(peerId: string): void {
    this.directConnectedPeers.delete(peerId);
    this.unverifiedRumors.delete(peerId);
  }

  public getStatus(): SignalingStatus {
    return {
      activeTransport: this.currentTransport,
      availableTransports: [...this.availableTransports],
      connectedPeers: Array.from(this.directConnectedPeers),
      latencyMs: this.state === 'CONNECTED' ? 25 : 999,
    };
  }
}
