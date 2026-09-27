export interface ProcessItem {
  pid: number;
  name: string;
  window_title?: string;
  exe_path?: string;
  is_likely_chat_or_voice: boolean;
  icon_base64?: string;
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

export interface StreamWatcher {
  peerId: string;
  username: string;
}

export interface RoomSlotInfo {
  peerId: string;
  senderName: string;
  stream: MediaStream | null;
  isStreaming: boolean;
  isLocal: boolean;
  color: string;
  watchers?: StreamWatcher[];
}

export interface ActiveStreamInfo {
  peerId: string;
  senderName: string;
  stream: MediaStream;
  isLocal: boolean;
}

export interface PeerStatsInfo {
  pingMs: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  bitrateKbps: number | null;
  connectionType: string;
}

export interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: number;
  isHost?: boolean;
  isSystem?: boolean;
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

export interface ResolutionConfig {
  width: number;
  height: number;
  label: string;
}

export interface AudioFilterConfig {
  mode: 'exclude' | 'include';
  targetPids: number[];
  targetNames: string[];
  sampleRate?: number;
}

export interface AudioStreamPayload {
  pcm_base64: string;
  sample_rate: number;
  channels: number;
  rms_level: number;
  timestamp_us?: number;
}

export interface PeerAudioSinkState {
  audioCtx: AudioContext;
  source: MediaStreamAudioSourceNode | null;
  gainNode: GainNode;
  streamId: string;
  volume: number;
  isMuted: boolean;
}

export interface StreamCardCacheItem {
  el: HTMLElement;
  isVideo: boolean;
  streamId?: string;
  subMode?: 'video' | 'connecting' | 'can_watch' | 'idle';
}

export type ThemeMode = 'dark' | 'light' | 'system';
export type StreamFilterMode = 'all' | 'streaming' | 'watching';

export type SignalingTransport = 'mqtt' | 'nostr' | 'torrent';
export type SignalingTransportType = SignalingTransport;

export interface SignalingStatus {
  activeTransport: SignalingTransport;
  availableTransports: SignalingTransport[];
  connectedPeers: string[];
  latencyMs: number;
}

export interface TransportStatusInfo {
  activeTransport: SignalingTransport;
  connectedRelays: number;
  totalRelays: number;
  isFailingOver: boolean;
  lastFailoverTime?: number;
}

export interface StreamStatusPayload {
  isStreaming: boolean;
  senderName?: string;
  streamId?: string;
  videoTrackId?: string;
  audioTrackId?: string;
  hasAudio?: boolean;
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  timestamp: number;
}

export interface StreamRequestPayload {
  request: boolean;
  broadcasterId: string;
  requesterId: string;
  reason?: 'initial_join' | 'stream_resumed' | 'track_ended_recovery';
}

export interface WatchStatusPayload {
  broadcasterId: string;
  isWatching: boolean;
  watcherName: string;
  watcherPeerId: string;
}

export interface VideoSourceOptions {
  mode: 'gpu_direct' | 'native_window' | 'native_monitor';
  sourceId?: string;
  frameRate: number;
}

export interface VideoCaptureBridge {
  startCapture(options: VideoSourceOptions): Promise<MediaStream>;
  stopCapture(): Promise<void>;
  listSources(): Promise<Array<{ id: string; name: string; thumbnail?: string }>>;
  onFallbackNeeded: ((reason: string, stream?: MediaStream) => void) | null;
}

export interface ProcessTelemetry {
  pid: number;
  name: string;
  role: string;
  cpu_pct: number;
  memory_mb: number;
  threads: number;
  run_time_secs: number;
}

export interface CpuCoreTelemetry {
  id: number;
  usage_pct: number;
  frequency_mhz: number;
}

export interface GpuTelemetry {
  name: string;
  temperature_c?: number;
  utilization_gpu_pct?: number;
  utilization_encoder_pct?: number;
  utilization_decoder_pct?: number;
  power_watts?: number;
  fan_speed_pct?: number;
  memory_used_mb?: number;
  memory_total_mb?: number;
  query_source: string;
}

export interface SubsystemTelemetry {
  is_screen_capturing: boolean;
  active_wgc: boolean;
  ws_port: number;
  is_audio_capturing: boolean;
}

export interface SystemTelemetryReport {
  timestamp_ms: number;
  cpu_global_pct: number;
  cpu_cores: CpuCoreTelemetry[];
  cpu_temperature_c?: number;
  memory_used_mb: number;
  memory_total_mb: number;
  p2sharer_processes: ProcessTelemetry[];
  total_p2sharer_cpu_pct: number;
  total_p2sharer_memory_mb: number;
  total_p2sharer_threads: number;
  gpu?: GpuTelemetry;
  subsystems: SubsystemTelemetry;
}

export interface TelemetryEvent {
  timestamp: number;
  category: 'CAPTURE' | 'WEBRTC' | 'AUDIO' | 'ROOM' | 'SYSTEM';
  message: string;
  data?: unknown;
}

