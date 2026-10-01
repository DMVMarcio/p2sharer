export interface RoomAppInstance {
  id: string;
  kind: string;
  createdBy: string;
  createdAt: number;
}

export interface YouTubeEntry {
  videoId: string;
  title: string;
  isLive?: boolean;
  addedBy?: string;
  addedByName?: string;
}

export interface YouTubeState {
  queue: YouTubeEntry[];
  index: number;
  playing: boolean;
  ended?: boolean;
  position: number;
  repeat: 'off' | 'all' | 'one';
  shuffle: boolean;
  removePlayed: boolean;
  updatedAt: number;
  syncReason?: 'heartbeat' | 'playback' | 'seek' | 'update' | 'queue-replace' | 'auto-advance';
}

export type AppWireEvent =
  | { kind: 'start'; instance: RoomAppInstance }
  | { kind: 'stop'; id: string }
  | { kind: 'data'; id: string; payload: unknown }
  | { kind: 'presence'; id: string; joined: boolean }
  | { kind: 'sync-request' }
  | { kind: 'sync'; instances: RoomAppInstance[]; snapshots: Record<string, unknown>; closed: string[] };
