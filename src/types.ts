export interface ProcessItem {
  pid: number;
  name: string;
  window_title?: string;
  is_likely_chat_or_voice: boolean;
}

export interface MonitorSource {
  id: string;
  name: string;
  width: number;
  height: number;
  is_primary: boolean;
  left?: number;
  top?: number;
  thumbnail?: string;
}

export interface WindowSource {
  id: string;
  title: string;
  process_name: string;
  pid: number;
  hwnd?: number;
  width: number;
  height: number;
  thumbnail?: string;
}

export interface ScreenSourcesResponse {
  monitors: MonitorSource[];
  windows: WindowSource[];
}

export interface PeerInfo {
  id: string;
  username: string;
  connectionState: 'connected' | 'connecting' | 'disconnected';
  joinedAt: number;
}

export interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: number;
  isHost?: boolean;
  isSystem?: boolean;
}

export interface ActiveStreamInfo {
  peerId: string;
  senderName: string;
  stream: MediaStream;
  isLocal: boolean;
}

export interface RoomSlotInfo {
  peerId: string;
  senderName: string;
  stream: MediaStream | null;
  isStreaming: boolean;
  isLocal: boolean;
  color: string;
}

export interface TurnConfig {
  enabled: boolean;
  url?: string;
  username?: string;
  credential?: string;
  forceRelay?: boolean;
}

export interface QualityProfile {
  id: string;
  name: string;
  width: number;
  height: number;
  fps?: number;
  frameRate?: number;
  maxBitrateKbps: number;
}

export interface RoomToken {
  version?: number;
  roomId?: string;
  type: 'offer' | 'answer';
  sdp: string;
  timestamp: number;
  hostName?: string;
  senderName?: string;
  peerId?: string;
}
