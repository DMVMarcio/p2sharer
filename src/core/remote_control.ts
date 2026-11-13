export type RemoteCursorShape =
  | 'default'
  | 'pointer'
  | 'text'
  | 'crosshair'
  | 'move'
  | 'not-allowed'
  | 'wait'
  | 'progress'
  | 'ns-resize'
  | 'ew-resize'
  | 'nwse-resize'
  | 'nesw-resize';

export type RemoteMouseButton = 'left' | 'right' | 'middle' | 'x1' | 'x2';

export type RemoteInputEvent =
  | {
      kind: 'mouseMove';
      x: number;
      y: number;
    }
  | {
      kind: 'mouseDelta';
      dx: number;
      dy: number;
    }
  | {
      kind: 'mouseButton';
      button: RemoteMouseButton;
      down: boolean;
      x?: number;
      y?: number;
    }
  | {
      kind: 'mouseWheel';
      deltaX: number;
      deltaY: number;
      x?: number;
      y?: number;
    }
  | {
      kind: 'key';
      code: string;
      key: string;
      down: boolean;
      repeat?: boolean;
      vk?: number;
      ctrlKey?: boolean;
      altKey?: boolean;
      metaKey?: boolean;
    }
  | {
      kind: 'releaseAll';
    };

export type RemoteControlClientPacket =
  | {
      type: 'request';
      mediaId: string;
      fastBinary?: boolean;
    }
  | {
      type: 'cancel';
      mediaId: string;
    }
  | {
      type: 'release';
      mediaId: string;
    }
  | {
      type: 'input';
      mediaId: string;
      event: RemoteInputEvent;
    };

export type RemoteControlHostPacket =
  | {
      type: 'accept';
      mediaId: string;
      mouseEnabled: boolean;
      keyboardEnabled: boolean;
      cursorCaptured: boolean;
      hostBusy: boolean;
      cursorShape: RemoteCursorShape;
      fastBinary?: boolean;
    }
  | {
      type: 'decline';
      mediaId: string;
    }
  | {
      type: 'revoke';
      mediaId: string;
      reason?: 'revoked' | 'stream-ended' | 'unsupported';
    }
  | {
      type: 'state';
      mediaId: string;
      mouseEnabled: boolean;
      keyboardEnabled: boolean;
      cursorCaptured: boolean;
      hostBusy: boolean;
      cursorShape: RemoteCursorShape;
    }
  | {
      type: 'cursorSync';
      mediaId: string;
      active: boolean;
      visible: boolean;
      x: number;
      y: number;
      cursorShape: RemoteCursorShape;
      imageId?: string;
      mouseLocked?: boolean;
      hostBusy: boolean;
      actorPeerId: string;
      embeddedInVideo: boolean;
    }
  | {
      type: 'cursorImage';
      mediaId: string;
      imageId: string;
      width: number;
      height: number;
      hotX: number;
      hotY: number;
      pngBase64: string;
    };

export interface RemoteCursorImageAsset {
  imageId: string;
  width: number;
  height: number;
  hotX: number;
  hotY: number;
  dataUrl: string;
}

export interface RemoteCursorSyncState {
  mediaId: string;
  hostPeerId: string;
  active: boolean;
  visible: boolean;
  x: number;
  y: number;
  cursorShape: RemoteCursorShape;
  imageId: string;
  mouseLocked: boolean;
  hostBusy: boolean;
  actorPeerId: string;
  embeddedInVideo: boolean;
  updatedAt: number;
}

export interface RemoteControlRequest {
  id: string;
  peerId: string;
  mediaId: string;
  createdAt: number;
}

export interface RemoteControllerInfo {
  peerId: string;
  mediaId: string;
  mouseEnabled: boolean;
  keyboardEnabled: boolean;
  connectedAt: number;
}

export type RemoteControlStatus = 'idle' | 'pending' | 'active';

export interface RemoteControlViewerState {
  mediaId: string;
  hostPeerId: string;
  status: RemoteControlStatus;
  mouseEnabled: boolean;
  keyboardEnabled: boolean;
  cursorCaptured: boolean;
  hostBusy: boolean;
  cursorShape: RemoteCursorShape;
  fastBinary?: boolean;
}

const VALID_CURSOR_SHAPES = new Set<RemoteCursorShape>([
  'default',
  'pointer',
  'text',
  'crosshair',
  'move',
  'not-allowed',
  'wait',
  'progress',
  'ns-resize',
  'ew-resize',
  'nwse-resize',
  'nesw-resize',
]);

const VALID_MOUSE_BUTTONS = new Set<RemoteMouseButton>(['left', 'right', 'middle', 'x1', 'x2']);

function isFiniteCoord(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isFiniteDelta(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 20000;
}

function isMediaId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160;
}

export function normalizeCursorShape(value: unknown): RemoteCursorShape {
  return typeof value === 'string' && VALID_CURSOR_SHAPES.has(value as RemoteCursorShape)
    ? (value as RemoteCursorShape)
    : 'default';
}

export function validRemoteInputEvent(raw: unknown): raw is RemoteInputEvent {
  if (!raw || typeof raw !== 'object') return false;
  const event = raw as Record<string, unknown>;
  switch (event.kind) {
    case 'mouseMove':
      return isFiniteCoord(event.x) && isFiniteCoord(event.y);
    case 'mouseDelta':
      return (
        typeof event.dx === 'number' &&
        Number.isInteger(event.dx) &&
        Math.abs(event.dx) <= 10000 &&
        typeof event.dy === 'number' &&
        Number.isInteger(event.dy) &&
        Math.abs(event.dy) <= 10000
      );
    case 'mouseButton':
      return (
        typeof event.button === 'string' &&
        VALID_MOUSE_BUTTONS.has(event.button as RemoteMouseButton) &&
        typeof event.down === 'boolean' &&
        (event.x === undefined || isFiniteCoord(event.x)) &&
        (event.y === undefined || isFiniteCoord(event.y))
      );
    case 'mouseWheel':
      return (
        isFiniteDelta(event.deltaX) &&
        isFiniteDelta(event.deltaY) &&
        (event.x === undefined || isFiniteCoord(event.x)) &&
        (event.y === undefined || isFiniteCoord(event.y))
      );
    case 'key':
      return (
        typeof event.code === 'string' &&
        event.code.length <= 64 &&
        typeof event.key === 'string' &&
        event.key.length <= 64 &&
        typeof event.down === 'boolean' &&
        (event.repeat === undefined || typeof event.repeat === 'boolean') &&
        (event.vk === undefined ||
          (typeof event.vk === 'number' && Number.isInteger(event.vk) && event.vk >= 0 && event.vk <= 0xff)) &&
        (event.ctrlKey === undefined || typeof event.ctrlKey === 'boolean') &&
        (event.altKey === undefined || typeof event.altKey === 'boolean') &&
        (event.metaKey === undefined || typeof event.metaKey === 'boolean')
      );
    case 'releaseAll':
      return true;
    default:
      return false;
  }
}

export function validRemoteControlClientPacket(raw: unknown): raw is RemoteControlClientPacket {
  if (!raw || typeof raw !== 'object') return false;
  const pkt = raw as Record<string, unknown>;
  if (!isMediaId(pkt.mediaId)) return false;
  switch (pkt.type) {
    case 'request':
      return pkt.fastBinary === undefined || typeof pkt.fastBinary === 'boolean';
    case 'cancel':
    case 'release':
      return true;
    case 'input':
      return validRemoteInputEvent(pkt.event);
    default:
      return false;
  }
}

export function validRemoteControlHostPacket(raw: unknown): raw is RemoteControlHostPacket {
  if (!raw || typeof raw !== 'object') return false;
  const pkt = raw as Record<string, unknown>;
  if (!isMediaId(pkt.mediaId)) return false;
  switch (pkt.type) {
    case 'decline':
      return true;
    case 'revoke':
      return (
        pkt.reason === undefined ||
        pkt.reason === 'revoked' ||
        pkt.reason === 'stream-ended' ||
        pkt.reason === 'unsupported'
      );
    case 'accept':
      return (
        typeof pkt.mouseEnabled === 'boolean' &&
        typeof pkt.keyboardEnabled === 'boolean' &&
        typeof pkt.cursorCaptured === 'boolean' &&
        typeof pkt.hostBusy === 'boolean' &&
        typeof pkt.cursorShape === 'string' &&
        VALID_CURSOR_SHAPES.has(pkt.cursorShape as RemoteCursorShape) &&
        (pkt.fastBinary === undefined || typeof pkt.fastBinary === 'boolean')
      );
    case 'state':
      return (
        typeof pkt.mouseEnabled === 'boolean' &&
        typeof pkt.keyboardEnabled === 'boolean' &&
        typeof pkt.cursorCaptured === 'boolean' &&
        typeof pkt.hostBusy === 'boolean' &&
        typeof pkt.cursorShape === 'string' &&
        VALID_CURSOR_SHAPES.has(pkt.cursorShape as RemoteCursorShape)
      );
    case 'cursorSync':
      return (
        typeof pkt.active === 'boolean' &&
        typeof pkt.visible === 'boolean' &&
        isFiniteCoord(pkt.x) &&
        isFiniteCoord(pkt.y) &&
        typeof pkt.cursorShape === 'string' &&
        VALID_CURSOR_SHAPES.has(pkt.cursorShape as RemoteCursorShape) &&
        (pkt.imageId === undefined || (typeof pkt.imageId === 'string' && pkt.imageId.length <= 64)) &&
        (pkt.mouseLocked === undefined || typeof pkt.mouseLocked === 'boolean') &&
        typeof pkt.hostBusy === 'boolean' &&
        typeof pkt.actorPeerId === 'string' &&
        pkt.actorPeerId.length <= 96 &&
        typeof pkt.embeddedInVideo === 'boolean'
      );
    case 'cursorImage':
      return (
        typeof pkt.imageId === 'string' &&
        pkt.imageId.length > 0 &&
        pkt.imageId.length <= 64 &&
        typeof pkt.width === 'number' &&
        Number.isInteger(pkt.width) &&
        pkt.width >= 1 &&
        pkt.width <= 128 &&
        typeof pkt.height === 'number' &&
        Number.isInteger(pkt.height) &&
        pkt.height >= 1 &&
        pkt.height <= 128 &&
        typeof pkt.hotX === 'number' &&
        Number.isInteger(pkt.hotX) &&
        pkt.hotX >= 0 &&
        pkt.hotX < pkt.width &&
        typeof pkt.hotY === 'number' &&
        Number.isInteger(pkt.hotY) &&
        pkt.hotY >= 0 &&
        pkt.hotY < pkt.height &&
        typeof pkt.pngBase64 === 'string' &&
        pkt.pngBase64.length > 0 &&
        pkt.pngBase64.length <= 65536
      );
    default:
      return false;
  }
}

export function createIdleViewerState(mediaId = '', hostPeerId = ''): RemoteControlViewerState {
  return {
    mediaId,
    hostPeerId,
    status: 'idle',
    mouseEnabled: true,
    keyboardEnabled: true,
    cursorCaptured: true,
    hostBusy: false,
    cursorShape: 'default',
  };
}

// Binary direct WebRTC DataChannel codec ('R', 'C', version=1).
// Magic 0x5243 (> 2048) never collides with PeerPayloadChannels JSON length prefixes.
const RC_MAGIC_0 = 0x52;
const RC_MAGIC_1 = 0x43;
const RC_VERSION = 0x01;
const OP_MOUSE_MOVE = 1;
const OP_MOUSE_BUTTON = 2;
const OP_MOUSE_WHEEL = 3;
const OP_KEY = 4;
const OP_RELEASE_ALL = 5;
const OP_CURSOR_SYNC = 6;
const OP_MOUSE_DELTA = 7;
const MOUSE_BUTTONS: RemoteMouseButton[] = ['left', 'right', 'middle', 'x1', 'x2'];
const CURSOR_SHAPES_ORDER: RemoteCursorShape[] = [
  'default',
  'pointer',
  'text',
  'crosshair',
  'move',
  'not-allowed',
  'wait',
  'progress',
  'ns-resize',
  'ew-resize',
  'nwse-resize',
  'nesw-resize',
];
const rcTextEncoder = new TextEncoder();
const rcTextDecoder = new TextDecoder('utf-8', { fatal: true });

export interface DecodedRemoteControlBinaryInput {
  mediaId: string;
  seq: number;
  event: RemoteInputEvent;
}

export function isRemoteControlBinaryFrame(frame: Uint8Array): boolean {
  return frame.length >= 9 && frame[0] === RC_MAGIC_0 && frame[1] === RC_MAGIC_1 && frame[2] === RC_VERSION;
}

export function encodeRemoteControlBinaryInput(
  mediaId: string,
  event: RemoteInputEvent,
  seq = 0,
): Uint8Array | null {
  const mediaBytes = rcTextEncoder.encode(mediaId);
  if (mediaBytes.length === 0 || mediaBytes.length > 64) return null;
  const headerSize = 9 + mediaBytes.length;

  const alloc = (op: number, extraBytes: number) => {
    const buf = new Uint8Array(headerSize + extraBytes);
    const view = new DataView(buf.buffer);
    buf[0] = RC_MAGIC_0;
    buf[1] = RC_MAGIC_1;
    buf[2] = RC_VERSION;
    buf[3] = op;
    buf[4] = mediaBytes.length;
    buf.set(mediaBytes, 5);
    view.setUint32(5 + mediaBytes.length, seq >>> 0);
    return { buf, view, offset: headerSize };
  };

  switch (event.kind) {
    case 'mouseMove': {
      const { buf, view, offset } = alloc(OP_MOUSE_MOVE, 8);
      view.setFloat32(offset, event.x);
      view.setFloat32(offset + 4, event.y);
      return buf;
    }
    case 'mouseDelta': {
      const dx = Math.max(-10000, Math.min(10000, Math.round(event.dx)));
      const dy = Math.max(-10000, Math.min(10000, Math.round(event.dy)));
      const { buf, view, offset } = alloc(OP_MOUSE_DELTA, 8);
      view.setInt32(offset, dx);
      view.setInt32(offset + 4, dy);
      return buf;
    }
    case 'mouseButton': {
      const btnIdx = MOUSE_BUTTONS.indexOf(event.button);
      if (btnIdx < 0) return null;
      const hasCoords = event.x !== undefined && event.y !== undefined;
      const { buf, view, offset } = alloc(OP_MOUSE_BUTTON, hasCoords ? 10 : 2);
      buf[offset] = btnIdx;
      buf[offset + 1] = (event.down ? 1 : 0) | (hasCoords ? 2 : 0);
      if (hasCoords) {
        view.setFloat32(offset + 2, event.x!);
        view.setFloat32(offset + 6, event.y!);
      }
      return buf;
    }
    case 'mouseWheel': {
      const hasCoords = event.x !== undefined && event.y !== undefined;
      const { buf, view, offset } = alloc(OP_MOUSE_WHEEL, hasCoords ? 17 : 9);
      view.setFloat32(offset, event.deltaX);
      view.setFloat32(offset + 4, event.deltaY);
      buf[offset + 8] = hasCoords ? 1 : 0;
      if (hasCoords) {
        view.setFloat32(offset + 9, event.x!);
        view.setFloat32(offset + 13, event.y!);
      }
      return buf;
    }
    case 'key': {
      const codeBytes = rcTextEncoder.encode(event.code);
      const keyBytes = rcTextEncoder.encode(event.key);
      if (codeBytes.length > 64 || keyBytes.length > 64) return null;
      const hasVk = event.vk !== undefined;
      const flags =
        (event.down ? 1 : 0) |
        (event.repeat ? 2 : 0) |
        (event.ctrlKey ? 4 : 0) |
        (event.altKey ? 8 : 0) |
        (event.metaKey ? 16 : 0) |
        (hasVk ? 32 : 0);
      const { buf, offset } = alloc(OP_KEY, 4 + codeBytes.length + keyBytes.length);
      buf[offset] = flags;
      buf[offset + 1] = hasVk ? (event.vk! & 0xff) : 0;
      buf[offset + 2] = codeBytes.length;
      buf[offset + 3] = keyBytes.length;
      buf.set(codeBytes, offset + 4);
      buf.set(keyBytes, offset + 4 + codeBytes.length);
      return buf;
    }
    case 'releaseAll': {
      const { buf } = alloc(OP_RELEASE_ALL, 0);
      return buf;
    }
    default:
      return null;
  }
}

export function decodeRemoteControlBinaryInput(frame: Uint8Array): DecodedRemoteControlBinaryInput | null {
  if (!isRemoteControlBinaryFrame(frame)) return null;
  const op = frame[3];
  const mediaLen = frame[4];
  if (mediaLen === 0 || mediaLen > 64 || 9 + mediaLen > frame.length) return null;
  let mediaId: string;
  try {
    mediaId = rcTextDecoder.decode(frame.subarray(5, 5 + mediaLen));
  } catch {
    return null;
  }
  if (!isMediaId(mediaId)) return null;

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const seq = view.getUint32(5 + mediaLen);
  const offset = 9 + mediaLen;
  const readCoord = (v: number) => Math.max(0, Math.min(1, v));

  let event: RemoteInputEvent | null = null;
  switch (op) {
    case OP_MOUSE_MOVE: {
      if (frame.length !== offset + 8) return null;
      const x = readCoord(view.getFloat32(offset));
      const y = readCoord(view.getFloat32(offset + 4));
      event = { kind: 'mouseMove', x, y };
      break;
    }
    case OP_MOUSE_DELTA: {
      if (frame.length !== offset + 8) return null;
      const dx = view.getInt32(offset);
      const dy = view.getInt32(offset + 4);
      event = { kind: 'mouseDelta', dx, dy };
      break;
    }
    case OP_MOUSE_BUTTON: {
      if (frame.length < offset + 2) return null;
      const button = MOUSE_BUTTONS[frame[offset]];
      if (!button) return null;
      const flags = frame[offset + 1];
      const down = (flags & 1) !== 0;
      const hasCoords = (flags & 2) !== 0;
      if (hasCoords) {
        if (frame.length !== offset + 10) return null;
        event = {
          kind: 'mouseButton',
          button,
          down,
          x: readCoord(view.getFloat32(offset + 2)),
          y: readCoord(view.getFloat32(offset + 6)),
        };
      } else {
        if (frame.length !== offset + 2) return null;
        event = { kind: 'mouseButton', button, down };
      }
      break;
    }
    case OP_MOUSE_WHEEL: {
      if (frame.length < offset + 9) return null;
      const deltaX = view.getFloat32(offset);
      const deltaY = view.getFloat32(offset + 4);
      const hasCoords = frame[offset + 8] === 1;
      if (hasCoords) {
        if (frame.length !== offset + 17) return null;
        event = {
          kind: 'mouseWheel',
          deltaX,
          deltaY,
          x: readCoord(view.getFloat32(offset + 9)),
          y: readCoord(view.getFloat32(offset + 13)),
        };
      } else {
        if (frame.length !== offset + 9) return null;
        event = { kind: 'mouseWheel', deltaX, deltaY };
      }
      break;
    }
    case OP_KEY: {
      if (frame.length < offset + 4) return null;
      const flags = frame[offset];
      const vk = (flags & 32) !== 0 ? frame[offset + 1] : undefined;
      const codeLen = frame[offset + 2];
      const keyLen = frame[offset + 3];
      if (codeLen > 64 || keyLen > 64 || frame.length !== offset + 4 + codeLen + keyLen) return null;
      try {
        const code = rcTextDecoder.decode(frame.subarray(offset + 4, offset + 4 + codeLen));
        const key = rcTextDecoder.decode(frame.subarray(offset + 4 + codeLen, offset + 4 + codeLen + keyLen));
        event = {
          kind: 'key',
          code,
          key,
          down: (flags & 1) !== 0,
          ...((flags & 2) !== 0 ? { repeat: true } : {}),
          ...((flags & 4) !== 0 ? { ctrlKey: true } : {}),
          ...((flags & 8) !== 0 ? { altKey: true } : {}),
          ...((flags & 16) !== 0 ? { metaKey: true } : {}),
          ...(vk !== undefined ? { vk } : {}),
        };
      } catch {
        return null;
      }
      break;
    }
    case OP_RELEASE_ALL: {
      if (frame.length !== offset) return null;
      event = { kind: 'releaseAll' };
      break;
    }
    default:
      return null;
  }

  return validRemoteInputEvent(event) ? { mediaId, seq, event } : null;
}

export interface DecodedRemoteControlCursorSync {
  seq: number;
  packet: Extract<RemoteControlHostPacket, { type: 'cursorSync' }>;
}

export function encodeRemoteControlCursorSync(
  packet: Extract<RemoteControlHostPacket, { type: 'cursorSync' }>,
  seq = 0,
): Uint8Array | null {
  if (!validRemoteControlHostPacket(packet)) return null;
  const mediaBytes = rcTextEncoder.encode(packet.mediaId);
  const actorBytes = rcTextEncoder.encode(packet.actorPeerId);
  const imageBytes = rcTextEncoder.encode(packet.imageId ?? '');
  if (
    mediaBytes.length === 0 ||
    mediaBytes.length > 64 ||
    actorBytes.length > 96 ||
    imageBytes.length > 64
  ) {
    return null;
  }
  const shapeIdx = CURSOR_SHAPES_ORDER.indexOf(packet.cursorShape);
  if (shapeIdx < 0) return null;

  const headerSize = 9 + mediaBytes.length;
  const buf = new Uint8Array(headerSize + 12 + actorBytes.length + imageBytes.length);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  buf[0] = RC_MAGIC_0;
  buf[1] = RC_MAGIC_1;
  buf[2] = RC_VERSION;
  buf[3] = OP_CURSOR_SYNC;
  buf[4] = mediaBytes.length;
  buf.set(mediaBytes, 5);
  view.setUint32(5 + mediaBytes.length, seq >>> 0);

  const flags =
    (packet.active ? 1 : 0) |
    (packet.visible ? 2 : 0) |
    (packet.hostBusy ? 4 : 0) |
    (packet.embeddedInVideo ? 8 : 0) |
    (packet.mouseLocked ? 16 : 0);
  buf[headerSize] = flags;
  buf[headerSize + 1] = shapeIdx;
  buf[headerSize + 2] = actorBytes.length;
  view.setFloat32(headerSize + 3, packet.x);
  view.setFloat32(headerSize + 7, packet.y);
  buf.set(actorBytes, headerSize + 11);
  buf[headerSize + 11 + actorBytes.length] = imageBytes.length;
  buf.set(imageBytes, headerSize + 12 + actorBytes.length);
  return buf;
}

export function decodeRemoteControlCursorSync(frame: Uint8Array): DecodedRemoteControlCursorSync | null {
  if (!isRemoteControlBinaryFrame(frame) || frame[3] !== OP_CURSOR_SYNC) return null;
  const mediaLen = frame[4];
  if (mediaLen === 0 || mediaLen > 64 || 9 + mediaLen + 11 > frame.length) return null;
  let mediaId: string;
  try {
    mediaId = rcTextDecoder.decode(frame.subarray(5, 5 + mediaLen));
  } catch {
    return null;
  }
  if (!isMediaId(mediaId)) return null;

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const seq = view.getUint32(5 + mediaLen);
  const offset = 9 + mediaLen;
  const flags = frame[offset];
  const cursorShape = CURSOR_SHAPES_ORDER[frame[offset + 1]];
  const actorLen = frame[offset + 2];
  if (!cursorShape || actorLen > 96 || offset + 11 + actorLen > frame.length) return null;
  let actorPeerId: string;
  let imageId = '';
  try {
    actorPeerId = rcTextDecoder.decode(frame.subarray(offset + 11, offset + 11 + actorLen));
    const tailOffset = offset + 11 + actorLen;
    if (tailOffset < frame.length) {
      const imageLen = frame[tailOffset];
      if (imageLen > 64 || frame.length !== tailOffset + 1 + imageLen) return null;
      imageId = rcTextDecoder.decode(frame.subarray(tailOffset + 1, tailOffset + 1 + imageLen));
    }
  } catch {
    return null;
  }
  const readCoord = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : -1);
  const packet: Extract<RemoteControlHostPacket, { type: 'cursorSync' }> = {
    type: 'cursorSync',
    mediaId,
    active: (flags & 1) !== 0,
    visible: (flags & 2) !== 0,
    x: readCoord(view.getFloat32(offset + 3)),
    y: readCoord(view.getFloat32(offset + 7)),
    cursorShape,
    imageId,
    mouseLocked: (flags & 16) !== 0,
    hostBusy: (flags & 4) !== 0,
    actorPeerId,
    embeddedInVideo: (flags & 8) !== 0,
  };
  return validRemoteControlHostPacket(packet) ? { seq, packet } : null;
}
