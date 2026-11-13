import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';
import {
  streamPointerClampedPosition,
  streamPointerPosition,
  streamPointerVideoRect,
} from '../core/stream_pointer.ts';
import type {
  RemoteControlStatus,
  RemoteControlViewerState,
  RemoteCursorShape,
  RemoteMouseButton,
} from '../core/remote_control.ts';
import { invoke } from '../platform/commands.ts';
import { logDiagnostic } from '../core/logger.ts';
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
  localCursor: boolean;
  pointerInside: boolean;
  cursorCss: string | undefined;
  toggleRequest: () => void;
  exit: () => void;
  toggleImmersive: () => void;
  toggleLocalCursor: () => void;
  setOverlayHovered: (hovered: boolean) => void;
}

const MOUSE_BUTTON_MAP: Record<number, RemoteMouseButton> = {
  0: 'left',
  1: 'middle',
  2: 'right',
  3: 'x1',
  4: 'x2',
};

// Minimal spacing avoids flooding sub-4ms USB bursts while dispatching initial
// and per-frame moves with zero artificial 22ms timer hold.
const MIN_MOVE_INTERVAL_MS = 4;

function isVideoInteractionTarget(target: EventTarget | null, container: HTMLElement | null): boolean {
  if (!(target instanceof Element) || !container) return false;
  if (!container.contains(target)) return false;
  return !target.closest('.remote-control-floating-overlay, .modal-backdrop, .chat-file-toasts');
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], .remote-control-floating-overlay'));
}

function isTextInputElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, select, [contenteditable="true"]',
    ),
  );
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
  const [localCursor, setLocalCursor] = useState(true);
  const [pointerInside, setPointerInside] = useState(false);
  const [overlayHovered, setOverlayHovered] = useState(false);
  const [holdingInput, setHoldingInput] = useState(false);
  const [windowFocused, setWindowFocused] = useState(() =>
    typeof document === 'undefined' ? true : document.hasFocus() && !document.hidden,
  );

  const lastMoveSentRef = useRef(0);
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);
  const trailingMoveRafRef = useRef<number | null>(null);
  const hadActiveInputRef = useRef(false);
  const heldButtonsRef = useRef(new Set<RemoteMouseButton>());
  const heldKeysRef = useRef(new Set<string>());
  const clipActiveRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const pointerInsideRef = useRef(false);
  const overlayHoveredRef = useRef(false);
  const immersiveRef = useRef(immersive);
  const windowFocusedRef = useRef(windowFocused);
  const hostBusyRef = useRef(hostBusy);
  const mouseEnabledRef = useRef(mouseEnabled);
  const keyboardEnabledRef = useRef(keyboardEnabled);

  pointerInsideRef.current = pointerInside;
  overlayHoveredRef.current = overlayHovered;
  immersiveRef.current = immersive;
  windowFocusedRef.current = windowFocused;
  hostBusyRef.current = hostBusy;
  mouseEnabledRef.current = mouseEnabled;
  keyboardEnabledRef.current = keyboardEnabled;

  const hasActiveHold = useCallback(
    () => heldButtonsRef.current.size > 0 || heldKeysRef.current.size > 0,
    [],
  );

  const syncCursorClip = useCallback(
    (forceUnlock = false) => {
      if (!isTauri()) return;
      const shouldClip =
        !forceUnlock &&
        active &&
        !hostBusyRef.current &&
        windowFocusedRef.current &&
        !document.hidden &&
        document.hasFocus() &&
        !overlayHoveredRef.current &&
        (heldButtonsRef.current.size > 0 || heldKeysRef.current.size > 0);
      if (!shouldClip) {
        if (clipActiveRef.current) {
          clipActiveRef.current = false;
          void invoke('set_remote_control_cursor_clip', { rect: null }).catch(() => {});
        }
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      const imageRect = streamPointerVideoRect(
        video.getBoundingClientRect(),
        video.videoWidth,
        video.videoHeight,
      );
      if (!imageRect || imageRect.width < 2 || imageRect.height < 2) return;
      clipActiveRef.current = true;
      void invoke('set_remote_control_cursor_clip', { rect: imageRect }).catch(() => {});
    },
    [active, videoRef],
  );

  const updateHoldTracking = useCallback(
    (forceUnlock = false) => {
      const nextHolding = !forceUnlock && (heldButtonsRef.current.size > 0 || heldKeysRef.current.size > 0);
      setHoldingInput(nextHolding);
      syncCursorClip(forceUnlock);
    },
    [syncCursorClip],
  );

  const sendReleaseAll = useCallback(() => {
    heldButtonsRef.current.clear();
    heldKeysRef.current.clear();
    if (activePointerIdRef.current !== null && containerRef.current) {
      try {
        if (containerRef.current.hasPointerCapture(activePointerIdRef.current)) {
          containerRef.current.releasePointerCapture(activePointerIdRef.current);
        }
      } catch {}
      activePointerIdRef.current = null;
    }
    updateHoldTracking(true);
    if (!hadActiveInputRef.current) return;
    hadActiveInputRef.current = false;
    pendingMoveRef.current = null;
    if (trailingMoveRafRef.current !== null) {
      cancelAnimationFrame(trailingMoveRafRef.current);
      trailingMoveRafRef.current = null;
    }
    roomService.sendRemoteControlInput(slotPeerId, { kind: 'releaseAll' });
  }, [containerRef, slotPeerId, updateHoldTracking]);

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
    setImmersive((prev) => {
      const next = !prev;
      if (next) {
        containerRef.current?.focus({ preventScroll: true });
      }
      return next;
    });
  }, [containerRef]);

  const toggleLocalCursor = useCallback(() => {
    setLocalCursor((prev) => !prev);
  }, []);

  // Reset local interactive state when leaving active mode or becoming ineligible.
  useEffect(() => {
    if (!active) {
      setImmersive(false);
      setPointerInside(false);
      setOverlayHovered(false);
      heldButtonsRef.current.clear();
      heldKeysRef.current.clear();
      activePointerIdRef.current = null;
      setHoldingInput(false);
      hadActiveInputRef.current = false;
      pendingMoveRef.current = null;
      if (trailingMoveRafRef.current !== null) {
        cancelAnimationFrame(trailingMoveRafRef.current);
        trailingMoveRafRef.current = null;
      }
      if (clipActiveRef.current && isTauri()) {
        clipActiveRef.current = false;
        void invoke('set_remote_control_cursor_clip', { rect: null }).catch(() => {});
      }
    }
  }, [active]);

  // Keep OS low-level immersive hook active whenever immersive is enabled and our window is focused.
  const hookLive = active && !hostBusy && immersive && windowFocused;
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
      if (
        disposed ||
        !payload ||
        !keyboardEnabled ||
        hostBusy ||
        isTextInputElement(document.activeElement) ||
        (!pointerInside && !hasActiveHold() && !immersive)
      ) {
        return;
      }
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
  }, [active, hasActiveHold, hostBusy, immersive, keyboardEnabled, pointerInside, slotPeerId]);

  useEffect(() => {
    if (hostBusy || overlayHovered || !windowFocused || (!pointerInside && !hasActiveHold())) {
      sendReleaseAll();
    }
  }, [hasActiveHold, hostBusy, overlayHovered, pointerInside, sendReleaseAll, windowFocused]);

  // Pointer + keyboard forwarding over the watched video area.
  useEffect(() => {
    const container = containerRef.current;
    const video = videoRef.current;
    if (!active || !container || !video) return;

    container.classList.add('is-remote-control-active');
    video.classList.add('is-remote-control-active');
    const hadTabIndex = container.hasAttribute('tabindex');
    if (!hadTabIndex) container.tabIndex = -1;

    let perfMovesSent = 0;
    let perfMovesCoalesced = 0;
    let perfLastLogAt = performance.now();

    const maybeLogInputPerf = (nowPerf: number) => {
      if (nowPerf - perfLastLogAt < 10000) return;
      perfLastLogAt = nowPerf;
      if (perfMovesSent + perfMovesCoalesced === 0) return;
      logDiagnostic('INFO', 'remoteControl.inputPerf', 'Viewer pointer pacing summary', {
        slotPeerId,
        movesSent: perfMovesSent,
        movesCoalesced: perfMovesCoalesced,
      });
      perfMovesSent = 0;
      perfMovesCoalesced = 0;
    };

    const flushPendingMove = () => {
      if (trailingMoveRafRef.current !== null) {
        cancelAnimationFrame(trailingMoveRafRef.current);
        trailingMoveRafRef.current = null;
      }
      const next = pendingMoveRef.current;
      if (!next) return;
      pendingMoveRef.current = null;
      const now = performance.now();
      lastMoveSentRef.current = now;
      hadActiveInputRef.current = true;
      perfMovesSent += 1;
      roomService.sendRemoteControlInput(slotPeerId, { kind: 'mouseMove', x: next.x, y: next.y });
      maybeLogInputPerf(now);
    };

    const getPos = (clientX: number, clientY: number) =>
      streamPointerPosition(video.getBoundingClientRect(), video.videoWidth, video.videoHeight, clientX, clientY);

    const getClampedPos = (clientX: number, clientY: number) =>
      streamPointerClampedPosition(video.getBoundingClientRect(), video.videoWidth, video.videoHeight, clientX, clientY);

    const clearStuckOverlayHover = (target: EventTarget | null) => {
      if (overlayHoveredRef.current && isVideoInteractionTarget(target, container)) {
        overlayHoveredRef.current = false;
        setOverlayHovered(false);
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      clearStuckOverlayHover(event.target);
      if (!isVideoInteractionTarget(event.target, container) || overlayHoveredRef.current) return;
      if (!getPos(event.clientX, event.clientY)) return;
      activePointerIdRef.current = event.pointerId;
      try {
        container.setPointerCapture(event.pointerId);
      } catch {}
    };

    const handlePointerMove = (event: PointerEvent) => {
      const holding = hasActiveHold();
      if (!holding) {
        clearStuckOverlayHover(event.target);
        if (!isVideoInteractionTarget(event.target, container) || document.hidden || overlayHoveredRef.current) {
          if (pointerInsideRef.current) setPointerInside(false);
          return;
        }
      } else if (document.hidden || !windowFocusedRef.current) {
        return;
      }

      const pos = holding
        ? getClampedPos(event.clientX, event.clientY)
        : getPos(event.clientX, event.clientY);
      if (!pos) {
        if (!holding && pointerInsideRef.current) setPointerInside(false);
        return;
      }
      if (!pointerInsideRef.current) setPointerInside(true);
      if (hostBusyRef.current || !mouseEnabledRef.current) return;
      const now = performance.now();
      const elapsed = now - lastMoveSentRef.current;
      if (elapsed >= MIN_MOVE_INTERVAL_MS) {
        if (trailingMoveRafRef.current !== null) {
          cancelAnimationFrame(trailingMoveRafRef.current);
          trailingMoveRafRef.current = null;
        }
        pendingMoveRef.current = null;
        lastMoveSentRef.current = now;
        hadActiveInputRef.current = true;
        perfMovesSent += 1;
        roomService.sendRemoteControlInput(slotPeerId, { kind: 'mouseMove', x: pos.x, y: pos.y });
        maybeLogInputPerf(now);
      } else {
        pendingMoveRef.current = pos;
        perfMovesCoalesced += 1;
        if (trailingMoveRafRef.current === null) {
          trailingMoveRafRef.current = requestAnimationFrame(flushPendingMove);
        }
      }
    };

    const handlePointerLeave = () => {
      if (hasActiveHold()) return;
      if (pointerInsideRef.current) setPointerInside(false);
      sendReleaseAll();
    };

    const handleMouseDown = (event: MouseEvent) => {
      clearStuckOverlayHover(event.target);
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
      heldButtonsRef.current.add(button);
      updateHoldTracking();
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
      const button = MOUSE_BUTTON_MAP[event.button];
      const wasHeld = button ? heldButtonsRef.current.delete(button) : false;
      if (wasHeld) {
        if (heldButtonsRef.current.size === 0 && activePointerIdRef.current !== null) {
          try {
            if (container.hasPointerCapture(activePointerIdRef.current)) {
              container.releasePointerCapture(activePointerIdRef.current);
            }
          } catch {}
          activePointerIdRef.current = null;
        }
        updateHoldTracking();
      }
      const insideTarget = isVideoInteractionTarget(event.target, container) && !overlayHoveredRef.current;
      if (!wasHeld && !insideTarget) return;
      if (!button || hostBusyRef.current || !mouseEnabledRef.current) return;
      const pos = wasHeld ? getClampedPos(event.clientX, event.clientY) : getPos(event.clientX, event.clientY);
      if (!insideTarget && !getPos(event.clientX, event.clientY) && !hasActiveHold()) {
        setPointerInside(false);
      }
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
      if (!isVideoInteractionTarget(event.target, container) && !hasActiveHold()) return;
      if (overlayHoveredRef.current && !hasActiveHold()) return;
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
      const codeKey = event.code || event.key;
      const wasHeld = !down && codeKey ? heldKeysRef.current.has(codeKey) : false;
      if (
        !keyboardEnabledRef.current ||
        hostBusyRef.current ||
        !windowFocusedRef.current ||
        document.hidden ||
        !document.hasFocus()
      ) {
        return;
      }
      if (!wasHeld) {
        const allowScope =
          pointerInsideRef.current || hasActiveHold() || (immersiveRef.current && !isTextInputElement(event.target));
        if (!allowScope || (overlayHoveredRef.current && !immersiveRef.current && !hasActiveHold())) {
          return;
        }
        if (immersiveRef.current ? isTextInputElement(event.target) : isEditableTarget(event.target)) {
          return;
        }
      }
      event.preventDefault();
      event.stopPropagation();
      if (codeKey) {
        if (down) {
          if (!heldKeysRef.current.has(codeKey)) {
            heldKeysRef.current.add(codeKey);
            updateHoldTracking();
          }
        } else if (heldKeysRef.current.delete(codeKey)) {
          updateHoldTracking();
        }
      }
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

    container.addEventListener('pointerdown', handlePointerDown);
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
      container.removeEventListener('pointerdown', handlePointerDown);
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
  }, [active, containerRef, hasActiveHold, sendReleaseAll, slotPeerId, updateHoldTracking, videoRef]);

  const cursorCss =
    active && !hostBusy && (pointerInside || holdingInput) && !overlayHovered && mouseEnabled
      ? localCursor || !cursorCaptured
        ? cursorShape
        : 'none'
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
    localCursor,
    pointerInside,
    cursorCss,
    toggleRequest,
    exit,
    toggleImmersive,
    toggleLocalCursor,
    setOverlayHovered,
  };
}
