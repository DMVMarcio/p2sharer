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
    };

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
    case 'state':
      return (
        typeof pkt.mouseEnabled === 'boolean' &&
        typeof pkt.keyboardEnabled === 'boolean' &&
        typeof pkt.cursorCaptured === 'boolean' &&
        typeof pkt.hostBusy === 'boolean' &&
        typeof pkt.cursorShape === 'string' &&
        VALID_CURSOR_SHAPES.has(pkt.cursorShape as RemoteCursorShape)
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
