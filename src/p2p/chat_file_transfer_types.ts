import type { DirectFileOffer } from '../core/chat/chat_file_direct.ts';

export interface NativeChatFile {
  id: string;
  name: string;
  path: string;
  size: number;
  hash: string;
  isImage: boolean;
}
export interface FileRequest {
  requestId: string;
  messageId: string;
  peerId: string;
  peerName: string;
  path: string;
  name: string;
  preview: boolean;
}
export interface FileTimings {
  readMs: number;
  prepareMs: number;
  wireMs: number;
  verifyMs: number;
  writeMs: number;
  ackMs: number;
}
export interface FileTransportDiagnostics {
  protocol?: string;
  localCandidateType?: string;
  remoteCandidateType?: string;
  channelLabel?: string;
  queuedBytes?: number;
  queueLimitBytes?: number;
  pairBytesSent?: number;
  pairBytesReceived?: number;
  pairTimestamp?: number;
  pairBytesPerSecond?: number;
  availableOutgoingBitsPerSecond?: number;
  packetsDiscardedOnSend?: number;
}
export interface FileProgress {
  requestId: string;
  messageId: string;
  direction: 'send' | 'receive';
  bytes: number;
  total: number;
  status: 'pending' | 'active' | 'complete' | 'cancelled' | 'error';
  error?: string;
  preview?: string;
  previewBytes?: Uint8Array;
  saved?: boolean;
  nativeDirect?: boolean;
  previewOnly?: boolean;
  peerId?: string;
  fileName?: string;
  peerName?: string;
  startedAt?: number;
  isImage?: boolean;
  bytesPerSecond?: number;
  connectionType?: string;
  rttMs?: number | null;
  timings?: FileTimings;
  transport?: FileTransportDiagnostics;
}
export type FilePacket = {
  kind: 'request' | 'accept' | 'ready' | 'deny' | 'ack' | 'cancel';
  requestId: string;
  messageId: string;
  offset?: number;
  preview?: boolean;
  direct?: DirectFileOffer;
  signature: string;
};
export type FileSession = {
  messageId: string;
  peerId: string;
  peerName?: string;
  sourceId?: string;
  offset: number;
  sentOffset?: number;
  lastAckOffset?: number;
  sessionToken?: string;
  ackedOnce?: boolean;
  direct?: boolean;
  startedTransfer?: boolean;
  sending?: boolean;
  receiving?: boolean;
  writingUntil?: number;
  pendingChunks?: Map<number, Uint8Array>;
  total: number;
  direction: 'send' | 'receive';
  preview?: boolean;
  chunks?: Uint8Array[];
  timings: FileTimings;
};

export function newFileTimings(): FileTimings {
  return { readMs: 0, prepareMs: 0, wireMs: 0, verifyMs: 0, writeMs: 0, ackMs: 0 };
}
