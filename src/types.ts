export interface ProcessItem {
  pid: number;
  name: string;
  exe_path?: string;
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

export interface QualityProfile {
  id: string;
  name: string;
  width: number;
  height: number;
  frameRate: number;
  bitrateKbps: number;
}

export interface RoomToken {
  type: 'offer' | 'answer';
  senderName: string;
  peerId: string;
  sdp: string;
  candidates?: RTCIceCandidateInit[];
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: number;
  isHost?: boolean;
  isSystem?: boolean;
}

export interface PeerInfo {
  id: string;
  username: string;
  connectionState: string;
  joinedAt: number;
}
