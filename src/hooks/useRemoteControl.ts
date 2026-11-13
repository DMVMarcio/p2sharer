import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';
import { streamPointerPosition } from '../core/stream_pointer.ts';
import type {
  RemoteControlStatus,
  RemoteControlViewerState,
  RemoteCursorShape,
  RemoteMouseButton,
} from '../core/remote_control.ts';
import { invoke } from '../platform/commands.ts';
import { roomService } from '../services/room_service.ts';

interface ImmersiveKeyPayload {
  vk: number;
  code: string;
  key: string;
  down: boolean;
}

export interface RemoteControlHookState {
  status: RemoteControlStatus;
  pending: boolean;
  active: boolean;
  hostBusy: boolean;
  mouseEnabled: boolean;
  keyboardEnabled: boolean;
  cursorCaptured: boolean;
  cursorShape: RemoteCursorShape;
  immersive: boolean;
  pointerInside: boolean;
  cursorCss: string | undefined;
  toggleRequest: () => void;
  exit: () => void;
  toggleImmersive: () => void;
  setOverlayHovered: (hovered: boolean) => void;
}

const MOUSE_BUTTON_MAP: Record<number, RemoteMouseButton> = {
  0: 'left',
  1: 'middle',
  2: 'right',
  3: 'x1',
  4: 'x2',
};

const MOVE_THROTTLE_MS = 22;

function isVideoInteractionTarget(target: EventTarget | null, container: HTMLElement | null): boolean {
  if (!(target instanceof Element) || !container) return false;
  if (!container.contains(target)) return false;
  return !target.closest('.remote-control-floating-overlay, .modal-backdrop, .chat-file-toasts');
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], .remote-control-floating-overlay'));
}

export function useRemoteControl(
  containerRef: RefObject<HTMLElement | null>,
  videoRef: RefObject<HTMLVideoElement | null>,
  slotPeerId: string,
  eligible: boolean,
  viewerState: RemoteControlViewerState | undefined,
): RemoteControlHookState {
  const status: RemoteControlStatus = eligible && viewerState ? viewerState.status : 'idle';
  const active = status === 'active';
  const pending = status === 'pending';
  const hostBusy = active && Boolean(viewerState?.hostBusy);
  const mouseEnabled = Boolean(viewerState?.mouseEnabled);
  const keyboardEnabled = Boolean(viewerState?.keyboardEnabled);
  const cursorCaptured = Boolean(viewerState?.cursorCaptured);
  const cursorShape: RemoteCursorShape = viewerState?.cursorShape ?? 'default';

  const [immersive, setImmersive] = useState(false);
  const [pointerInside, setPointerInside] = useState(false);
  const [overlayHovered, setOverlayHovered] = useState(false);
  const [windowFocused, setWindowFocused] = useState(() =>
    typeof document === 'undefined' ? true : document.hasFocus() && !document.hidden,
  );

  const lastMoveSentRef = useRef(0);
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);
  const trailingMoveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hadActiveInputRef = useRef(false);
  const pointerInsideRef = useRef(false);
  const overlayHoveredRef = useRef(false);
  const windowFocusedRef = useRef(windowFocused);
  const hostBusyRef = useRef(hostBusy);
  const mouseEnabledRef = useRef(mouseEnabled);
  const keyboardEnabledRef = useRef(keyboardEnabled);

  pointerInsideRef.current = pointerInside;
  overlayHoveredRef.current = overlayHovered;
  windowFocusedRef.current = windowFocused;
  hostBusyRef.current = hostBusy;
  mouseEnabledRef.current = mouseEnabled;
  keyboardEnabledRef.current = keyboardEnabled;

  const sendReleaseAll = useCallback(() => {
    if (!hadActiveInputRef.current) return;
    hadActiveInputRef.current = false;
    pendingMoveRef.current = null;
    if (trailingMoveTimerRef.current) {
      clearTimeout(trailingMoveTimerRef.current);
      trailingMoveTimerRef.current = null;
    }
    roomService.sendRemoteControlInput(slotPeerId, { kind: 'releaseAll' });
  }, [slotPeerId]);

  const toggleRequest = useCallback(() => {
    if (!eligible) return;
    roomService.toggleRemoteControlRequest(slotPeerId);
  }, [eligible, slotPeerId]);

  const exit = useCallback(() => {
    sendReleaseAll();
    setImmersive(false);
    setPointerInside(false);
    setOverlayHovered(false);
    roomService.stopRemoteControlViewer(slotPeerId);
  }, [sendReleaseAll, slotPeerId]);

  const toggleImmersive = useCallback(() => {
    setImmersive((prev) => !prev);
  }, []);

  // Reset local interactive state when leaving active mode or becoming ineligible.
  useEffect(() => {
    if (!active) {
      setImmersive(false);
      setPointerInside(false);
      setOverlayHovered(false);
      hadActiveInputRef.current = false;
      pendingMoveRef.current = null;
      if (trailingMoveTimerRef.current) {
        clearTimeout(trailingMoveTimerRef.current);
        trailingMoveTimerRef.current = null;
      }
    }
  }, [active]);

  // Keep OS low-level immersive hook strictly scoped to active foreground hover inside the video.
  const hookLive = active && !hostBusy && immersive && pointerInside && !overlayHovered && windowFocused;
  useEffect(() => {
    if (!isTauri()) return;
    void invoke('set_remote_control_immersive', { enabled: hookLive }).catch(() => {});
    const nav = navigator as Navigator & {
      keyboard?: { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };
    };
    if (hookLive && document.fullscreenElement) {
      void nav.keyboard?.lock?.(['Escape']).catch(() => {});
    } else {
      try { nav.keyboard?.unlock?.(); } catch {}
    }
    return () => {
      if (hookLive) {
        void invoke('set_remote_control_immersive', { enabled: false }).catch(() => {});
        try { nav.keyboard?.unlock?.(); } catch {}
      }
    };
  }, [hookLive]);

  useEffect(() => {
    if (!active || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ImmersiveKeyPayload>('remote-control-immersive-key', ({ payload }) => {
      if (disposed || !payload || !keyboardEnabled || hostBusy || !pointerInside || overlayHovered) return;
      hadActiveInputRef.current = true;
      roomService.sendRemoteControlInput(slotPeerId, {
        kind: 'key',
        vk: payload.vk,
        code: payload.code,
        key: payload.key,
        down: payload.down,
      });
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [active, hostBusy, keyboardEnabled, overlayHovered, pointerInside, slotPeerId]);

  useEffect(() => {
    if (hostBusy || !pointerInside || overlayHovered || !windowFocused) {
      sendReleaseAll();
    }
  }, [hostBusy, overlayHovered, pointerInside, sendReleaseAll, windowFocused]);

  // Pointer + keyboard forwarding over the watched video area.
  useEffect(() => {
    const container = containerRef.current;
    const video = videoRef.current;
    if (!active || !container || !video) return;

    container.classList.add('is-remote-control-active');
    video.classList.add('is-remote-control-active');
    const hadTabIndex = container.hasAttribute('tabindex');
    if (!hadTabIndex) container.tabIndex = -1;

    const flushPendingMove = () => {
      if (trailingMoveTimerRef.current) {
        clearTimeout(trailingMoveTimerRef.current);
        trailingMoveTimerRef.current = null;
      }
      const next = pendingMoveRef.current;
      if (!next) return;
      pendingMoveRef.current = null;
      lastMoveSentRef.current = Date.now();
      hadActiveInputRef.current = true;
      roomService.sendRemoteControlInput(slotPeerId, { kind: 'mouseMove', x: next.x, y: next.y });
    };

    const getPos = (clientX: number, clientY: number) =>
      streamPointerPosition(video.getBoundingClientRect(), video.videoWidth, video.videoHeight, clientX, clientY);

    const handlePointerMove = (event: PointerEvent) => {
      if (!isVideoInteractionTarget(event.target, container) || document.hidden || overlayHoveredRef.current) {
        if (pointerInsideRef.current) setPointerInside(false);
        return;
      }
      const pos = getPos(event.clientX, event.clientY);
      if (!pos) {
        if (pointerInsideRef.current) setPointerInside(false);
        return;
      }
      if (!pointerInsideRef.current) setPointerInside(true);
      if (hostBusyRef.current || !mouseEnabledRef.current) return;
      const now = Date.now();
      const elapsed = now - lastMoveSentRef.current;
      if (elapsed >= MOVE_THROTTLE_MS) {
        if (trailingMoveTimerRef.current) {
          clearTimeout(trailingMoveTimerRef.current);
          trailingMoveTimerRef.current = null;
        }
        pendingMoveRef.current = null;
        lastMoveSentRef.current = now;
        hadActiveInputRef.current = true;
        roomService.sendRemoteControlInput(slotPeerId, { kind: 'mouseMove', x: pos.x, y: pos.y });
      } else {
        pendingMoveRef.current = pos;
        if (!trailingMoveTimerRef.current) {
          trailingMoveTimerRef.current = setTimeout(flushPendingMove, MOVE_THROTTLE_MS - elapsed);
        }
      }
    };

    const handlePointerLeave = () => {
      if (pointerInsideRef.current) setPointerInside(false);
      sendReleaseAll();
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (!isVideoInteractionTarget(event.target, container) || overlayHoveredRef.current) return;
      const pos = getPos(event.clientX, event.clientY);
      if (!pos) return;
      event.preventDefault();
      event.stopPropagation();
      container.focus({ preventScroll: true });
      if (!pointerInsideRef.current) setPointerInside(true);
      if (hostBusyRef.current || !mouseEnabledRef.current) return;
      const button = MOUSE_BUTTON_MAP[event.button];
      if (!button) return;
      flushPendingMove();
      hadActiveInputRef.current = true;
      roomService.sendRemoteControlInput(slotPeerId, {
        kind: 'mouseButton',
        button,
        down: true,
        x: pos.x,
        y: pos.y,
      });
    };

    const handleMouseUp = (event: MouseEvent) => {
      if (!isVideoInteractionTarget(event.target, container) || overlayHoveredRef.current) return;
      const button = MOUSE_BUTTON_MAP[event.button];
      if (!button || hostBusyRef.current || !mouseEnabledRef.current) return;
      const pos = getPos(event.clientX, event.clientY);
      event.preventDefault();
      event.stopPropagation();
      hadActiveInputRef.current = true;
      roomService.sendRemoteControlInput(slotPeerId, {
        kind: 'mouseButton',
        button,
        down: false,
        ...(pos ? { x: pos.x, y: pos.y } : {}),
      });
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (!isVideoInteractionTarget(event.target, container) || overlayHoveredRef.current) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleWheel = (event: WheelEvent) => {
      if (!isVideoInteractionTarget(event.target, container) || overlayHoveredRef.current) return;
      const pos = getPos(event.clientX, event.clientY);
      if (!pos) return;
      event.preventDefault();
      event.stopPropagation();
      if (hostBusyRef.current || !mouseEnabledRef.current) return;
      const multiplier = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? 400 : 1;
      hadActiveInputRef.current = true;
      roomService.sendRemoteControlInput(slotPeerId, {
        kind: 'mouseWheel',
        deltaX: event.deltaX * multiplier,
        deltaY: event.deltaY * multiplier,
        x: pos.x,
        y: pos.y,
      });
    };

    const handleKey = (event: KeyboardEvent, down: boolean) => {
      if (
        !keyboardEnabledRef.current ||
        hostBusyRef.current ||
        !pointerInsideRef.current ||
        overlayHoveredRef.current ||
        !windowFocusedRef.current ||
        document.hidden ||
        !document.hasFocus()
      ) {
        return;
      }
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      hadActiveInputRef.current = true;
      roomService.sendRemoteControlInput(slotPeerId, {
        kind: 'key',
        code: event.code,
        key: event.key,
        down,
        repeat: event.repeat,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      });
    };

    const onKeyDown = (event: KeyboardEvent) => handleKey(event, true);
    const onKeyUp = (event: KeyboardEvent) => handleKey(event, false);

    const onBlur = () => {
      setWindowFocused(false);
      setPointerInside(false);
      sendReleaseAll();
    };
    const onFocus = () => {
      setWindowFocused(!document.hidden);
    };
    const onVisibilityChange = () => {
      const visible = !document.hidden && document.hasFocus();
      setWindowFocused(visible);
      if (!visible) {
        setPointerInside(false);
        sendReleaseAll();
      }
    };

    container.addEventListener('pointermove', handlePointerMove);
    container.addEventListener('pointerleave', handlePointerLeave);
    container.addEventListener('mousedown', handleMouseDown, { capture: true });
    window.addEventListener('mouseup', handleMouseUp, { capture: true });
    container.addEventListener('contextmenu', handleContextMenu, { capture: true });
    container.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      container.classList.remove('is-remote-control-active');
      video.classList.remove('is-remote-control-active');
      if (!hadTabIndex) container.removeAttribute('tabindex');
      container.removeEventListener('pointermove', handlePointerMove);
      container.removeEventListener('pointerleave', handlePointerLeave);
      container.removeEventListener('mousedown', handleMouseDown, { capture: true });
      window.removeEventListener('mouseup', handleMouseUp, { capture: true });
      container.removeEventListener('contextmenu', handleContextMenu, { capture: true });
      container.removeEventListener('wheel', handleWheel, { capture: true });
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      sendReleaseAll();
    };
  }, [active, containerRef, sendReleaseAll, slotPeerId, videoRef]);

  const cursorCss =
    active && !hostBusy && pointerInside && !overlayHovered && mouseEnabled
      ? cursorCaptured
        ? 'none'
        : cursorShape
      : undefined;

  return {
    status,
    pending,
    active,
    hostBusy,
    mouseEnabled,
    keyboardEnabled,
    cursorCaptured,
    cursorShape,
    immersive,
    pointerInside,
    cursorCss,
    toggleRequest,
    exit,
    toggleImmersive,
    setOverlayHovered,
  };
}
