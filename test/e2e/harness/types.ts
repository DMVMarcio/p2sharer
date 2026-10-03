/**
 * Shared types for P2Sharer E2E Test Suite
 * Derives from PROJECT.md Interface Contracts and src/core/types.ts
 */

export interface ActiveStreamInfo {
  peerId: string;
  senderName: string;
  stream: unknown;
  joinedAt?: number;
}

export interface RoomSlotInfo {
  peerId: string;
  senderName: string;
  color: string;
  isStreaming: boolean;
  isLocal: boolean;
  stream: unknown | null;
  volume?: number;
  isMuted?: boolean;
}

export interface PeerInfo {
  peerId: string;
  username: string;
  isStreaming: boolean;
  isCreator: boolean;
  joinedAt: number;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  isSystem?: boolean;
}

export interface AudioStreamPayload {
  pcm_base64: string;
  sample_rate: number;
  channels: number;
  rms_level: number;
}

export interface AudioConfig {
  mode: 'full' | 'exclude' | 'include';
  target_pids: number[];
  target_names: string[];
  sample_rate: number;
}

export interface MonitorSource {
  id: string;
  name: string;
  width: number;
  height: number;
  is_primary: boolean;
  thumbnail?: string | null;
}

export interface WindowSource {
  id: string;
  title: string;
  process_name: string;
  pid: number;
  width: number;
  height: number;
  thumbnail?: string | null;
}

export interface ScreenSourcesResponse {
  monitors: MonitorSource[];
  windows: WindowSource[];
}

export type SignalingTransport = 'mqtt' | 'nostr' | 'torrent';

export interface SignalingStatus {
  activeTransport: SignalingTransport;
  availableTransports: SignalingTransport[];
  connectedPeers: string[];
  latencyMs: number;
}

export interface VideoSourceOptions {
  mode: 'gpu_direct' | 'native_window' | 'native_monitor';
  sourceId?: string;
  frameRate: number;
}

export interface StreamViewSlot {
  peerId: string;
  stream: unknown;
  isSpotlight: boolean;
  audioGainNode: unknown;
  videoElement: unknown;
}
