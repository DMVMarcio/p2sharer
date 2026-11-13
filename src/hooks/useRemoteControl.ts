import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
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
  RemoteCursorImageAsset,
  RemoteCursorShape,
  RemoteCursorSyncState,
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

interface RawMouseDeltaPayload {
  dx: number;
  dy: number;
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
  mouseLocked: boolean;
  manualMouseLock: boolean;
  pointerLocked: boolean;
  pointerInside: boolean;
  cursorCss: string | undefined;
  toggleRequest: () => void;
  exit: () => void;
  toggleImmersive: () => void;
  toggleManualMouseLock: () => void;
  setOverlayHovered: (hovered: boolean) => void;
  setOverlayMenuOpen: (open: boolean) => void;
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
  cursorSync?: RemoteCursorSyncState,
  cursorImages?: Record<string, RemoteCursorImageAsset>,
): RemoteControlHookState {
  const status: RemoteControlStatus = eligible && viewerState ? viewerState.status : 'idle';
  const active = status === 'active';
  const pending = status === 'pending';
  const hostBusy = active && Boolean(viewerState?.hostBusy);
  const mouseEnabled = Boolean(viewerState?.mouseEnabled);
  const keyboardEnabled = Boolean(viewerState?.keyboardEnabled);
  const cursorCaptured = Boolean(viewerState?.cursorCaptured);
  const cursorShape: RemoteCursorShape = viewerState?.cursorShape ?? 'default';
  const hostMouseLocked = Boolean(cursorSync?.active && cursorSync.mouseLocked);

  const [immersive, setImmersive] = useState(false);
  const [mouseLockOverride, setMouseLockOverride] = useState<'auto' | 'locked' | 'unlocked'>('auto');
  const [overlayMenuOpen, setOverlayMenuOpen] = useState(false);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [pointerInside, setPointerInside] = useState(false);
  const [overlayHovered, setOverlayHovered] = useState(false);
  const [holdingInput, setHoldingInput] = useState(false);
  const [windowFocused, setWindowFocused] = useState(() =>
    typeof document === 'undefined' ? true : document.hasFocus() && !document.hidden,
  );

  const manualMouseLock = mouseLockOverride === 'locked';
  const effectiveMouseLock =
    mouseLockOverride === 'locked' || (mouseLockOverride === 'auto' && hostMouseLocked);
  const wantPointerLock =
    active &&
    !hostBusy &&
    mouseEnabled &&
    windowFocused &&
    !overlayHovered &&
    !overlayMenuOpen &&
    effectiveMouseLock;

  const lastMoveSentRef = useRef(0);
  const lastSentPosRef = useRef<{ x: number; y: number } | null>(null);
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);
  const pendingDeltaRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const trailingMoveTimerRef = useRef<number | null>(null);
  const hadActiveInputRef = useRef(false);
  const heldButtonsRef = useRef(new Set<RemoteMouseButton>());
  const heldKeysRef = useRef(new Set<string>());
  const clipActiveRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const pointerInsideRef = useRef(false);
  const overlayHoveredRef = useRef(false);
  const overlayMenuOpenRef = useRef(false);
  const immersiveRef = useRef(immersive);
  const windowFocusedRef = useRef(windowFocused);
  const hostBusyRef = useRef(hostBusy);
  const mouseEnabledRef = useRef(mouseEnabled);
  const keyboardEnabledRef = useRef(keyboardEnabled);
  const hostMouseLockedRef = useRef(hostMouseLocked);
  const manualMouseLockRef = useRef(manualMouseLock);
  const wantPointerLockRef = useRef(wantPointerLock);
  const pointerLockedRef = useRef(pointerLocked);
  const programmaticUnlockRef = useRef(false);
  const lockPausedByEscapeRef = useRef(false);
  const rawLockDesiredRef = useRef(false);
  const rawLockGenRef = useRef(0);
  const rawPerfRef = useRef({ sent: 0, lastLogAt: 0 });

  pointerInsideRef.current = pointerInside;
  overlayHoveredRef.current = overlayHovered;
  overlayMenuOpenRef.current = overlayMenuOpen;
  immersiveRef.current = immersive;
  windowFocusedRef.current = windowFocused;
  hostBusyRef.current = hostBusy;
  mouseEnabledRef.current = mouseEnabled;
  keyboardEnabledRef.current = keyboardEnabled;
  hostMouseLockedRef.current = hostMouseLocked;
  manualMouseLockRef.current = manualMouseLock;
  wantPointerLockRef.current = wantPointerLock;
  pointerLockedRef.current = pointerLocked;

  useEffect(() => {
    if (!hostMouseLocked && mouseLockOverride === 'unlocked') {
      setMouseLockOverride('auto');
    }
  }, [hostMouseLocked, mouseLockOverride]);

  const clearTrailingMoveTimer = useCallback(() => {
    if (trailingMoveTimerRef.current !== null) {
      window.clearTimeout(trailingMoveTimerRef.current);
      trailingMoveTimerRef.current = null;
    }
  }, []);

  const isMouseLockedNow = useCallback(() => {
    if (isTauri()) return pointerLockedRef.current;
    const container = containerRef.current;
    return Boolean(container && document.pointerLockElement === container);
  }, [containerRef]);

  const getVideoClientRect = useCallback(() => {
    const video = videoRef.current;
    if (!video) return null;
    const imageRect = streamPointerVideoRect(
      video.getBoundingClientRect(),
      video.videoWidth,
      video.videoHeight,
    );
    if (!imageRect || imageRect.width < 2 || imageRect.height < 2) return null;
    return imageRect;
  }, [videoRef]);

  const tryAcquirePointerLock = useCallback(() => {
    const container = containerRef.current;
    if (!container || !wantPointerLockRef.current) return;

    if (isTauri()) {
      const imageRect = getVideoClientRect();
      if (!imageRect) return;
      const gen = ++rawLockGenRef.current;
      rawLockDesiredRef.current = true;
      void invoke<boolean>('set_remote_control_mouse_lock', {
        enabled: true,
        rect: imageRect,
      })
        .then((acquired) => {
          if (gen !== rawLockGenRef.current || !rawLockDesiredRef.current) {
            if (acquired) {
              void invoke('set_remote_control_mouse_lock', { enabled: false, rect: null }).catch(() => {});
            }
            return;
          }
          pointerLockedRef.current = acquired;
          setPointerLocked(acquired);
          if (acquired) {
            setPointerInside(true);
            clipActiveRef.current = false;
            lastSentPosRef.current = null;
          }
        })
        .catch(() => {});
      return;
    }

    if (lockPausedByEscapeRef.current || document.pointerLockElement === container) {
      return;
    }
    try {
      const req = (
        container as HTMLElement & {
          requestPointerLock?: (opts?: { unadjustedMovement?: boolean }) => Promise<void> | void;
        }
      ).requestPointerLock?.({ unadjustedMovement: true });
      void Promise.resolve(req).catch(() => {
        if (
          !wantPointerLockRef.current ||
          lockPausedByEscapeRef.current ||
          document.pointerLockElement === container
        ) {
          return;
        }
        try {
          void Promise.resolve(container.requestPointerLock?.()).catch(() => {});
        } catch {}
      });
    } catch {
      try {
        void Promise.resolve(container.requestPointerLock?.()).catch(() => {});
      } catch {}
    }
  }, [containerRef, getVideoClientRect]);

  const releasePointerLock = useCallback(() => {
    if (isTauri()) {
      const wasActiveOrDesired = rawLockDesiredRef.current || pointerLockedRef.current;
      rawLockDesiredRef.current = false;
      rawLockGenRef.current += 1;
      if (pointerLockedRef.current) {
        pointerLockedRef.current = false;
        setPointerLocked(false);
      }
      pendingDeltaRef.current = { x: 0, y: 0 };
      if (wasActiveOrDesired) {
        void invoke('set_remote_control_mouse_lock', { enabled: false, rect: null }).catch(() => {});
      }
      return;
    }
    const container = containerRef.current;
    if (!container || document.pointerLockElement !== container) return;
    programmaticUnlockRef.current = true;
    try {
      document.exitPointerLock?.();
    } catch {
      programmaticUnlockRef.current = false;
    }
  }, [containerRef]);

  const hasActiveHold = useCallback(
    () => heldButtonsRef.current.size > 0 || heldKeysRef.current.size > 0,
    [],
  );

  const syncCursorClip = useCallback(
    (forceUnlock = false) => {
      if (!isTauri()) return;
      const isLocked = isMouseLockedNow();
      const shouldClip =
        !forceUnlock &&
        active &&
        !isLocked &&
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
      const imageRect = getVideoClientRect();
      if (!imageRect) return;
      clipActiveRef.current = true;
      void invoke('set_remote_control_cursor_clip', { rect: imageRect }).catch(() => {});
    },
    [active, getVideoClientRect, isMouseLockedNow],
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
    pendingDeltaRef.current = { x: 0, y: 0 };
    if (!hadActiveInputRef.current) return;
    hadActiveInputRef.current = false;
    pendingMoveRef.current = null;
    clearTrailingMoveTimer();
    roomService.sendRemoteControlInput(slotPeerId, { kind: 'releaseAll' });
  }, [clearTrailingMoveTimer, containerRef, slotPeerId, updateHoldTracking]);

  const toggleRequest = useCallback(() => {
    if (!eligible) return;
    roomService.toggleRemoteControlRequest(slotPeerId);
  }, [eligible, slotPeerId]);

  const exit = useCallback(() => {
    releasePointerLock();
    sendReleaseAll();
    setImmersive(false);
    setMouseLockOverride('auto');
    setOverlayMenuOpen(false);
    setPointerInside(false);
    setOverlayHovered(false);
    roomService.stopRemoteControlViewer(slotPeerId);
  }, [releasePointerLock, sendReleaseAll, slotPeerId]);

  const toggleImmersive = useCallback(() => {
    setImmersive((prev) => {
      const next = !prev;
      if (next) {
        containerRef.current?.focus({ preventScroll: true });
      }
      return next;
    });
  }, [containerRef]);

  const toggleManualMouseLock = useCallback(() => {
    setMouseLockOverride((prev) => {
      const currentlyEnabled =
        prev === 'locked' || (prev === 'auto' && hostMouseLockedRef.current);
      const nextMode: 'auto' | 'locked' | 'unlocked' = currentlyEnabled
        ? hostMouseLockedRef.current
          ? 'unlocked'
          : 'auto'
        : 'locked';
      const nextLocked = nextMode === 'locked';
      lockPausedByEscapeRef.current = false;
      manualMouseLockRef.current = nextLocked;
      if (nextLocked) {
        wantPointerLockRef.current =
          active &&
          !hostBusyRef.current &&
          mouseEnabledRef.current &&
          windowFocusedRef.current;
        overlayMenuOpenRef.current = false;
        overlayHoveredRef.current = false;
        setOverlayMenuOpen(false);
        setOverlayHovered(false);
        setPointerInside(true);
        containerRef.current?.focus({ preventScroll: true });
        tryAcquirePointerLock();
      } else {
        wantPointerLockRef.current = false;
        releasePointerLock();
      }
      return nextMode;
    });
  }, [active, containerRef, releasePointerLock, tryAcquirePointerLock]);

  // Reset local interactive state when leaving active mode or becoming ineligible.
  useEffect(() => {
    if (!active) {
      releasePointerLock();
      setImmersive(false);
      setMouseLockOverride('auto');
      setOverlayMenuOpen(false);
      setPointerLocked(false);
      setPointerInside(false);
      setOverlayHovered(false);
      lockPausedByEscapeRef.current = false;
      heldButtonsRef.current.clear();
      heldKeysRef.current.clear();
      activePointerIdRef.current = null;
      setHoldingInput(false);
      hadActiveInputRef.current = false;
      pendingMoveRef.current = null;
      lastSentPosRef.current = null;
      pendingDeltaRef.current = { x: 0, y: 0 };
      clearTrailingMoveTimer();
      if (clipActiveRef.current && isTauri()) {
        clipActiveRef.current = false;
        void invoke('set_remote_control_cursor_clip', { rect: null }).catch(() => {});
      }
    }
  }, [active, clearTrailingMoveTimer, releasePointerLock]);

  useEffect(() => {
    if (!isTauri() || !active) return;
    let disposed = false;
    let unlistenDelta: (() => void) | undefined;
    let unlistenLost: (() => void) | undefined;

    void listen<RawMouseDeltaPayload>('remote-control-raw-delta', ({ payload }) => {
      if (
        disposed ||
        !payload ||
        !pointerLockedRef.current ||
        hostBusyRef.current ||
        !mouseEnabledRef.current ||
        !windowFocusedRef.current ||
        document.hidden ||
        overlayHoveredRef.current ||
        overlayMenuOpenRef.current
      ) {
        return;
      }
      const dx = Number.isFinite(payload.dx) ? Math.trunc(payload.dx) : 0;
      const dy = Number.isFinite(payload.dy) ? Math.trunc(payload.dy) : 0;
      if (dx === 0 && dy === 0) return;
      hadActiveInputRef.current = true;
      roomService.sendRemoteControlInput(slotPeerId, { kind: 'mouseDelta', dx, dy });
      const nowPerf = performance.now();
      rawPerfRef.current.sent += 1;
      if (nowPerf - rawPerfRef.current.lastLogAt >= 10000) {
        rawPerfRef.current.lastLogAt = nowPerf;
        logDiagnostic('INFO', 'remoteControl.rawDelta', 'Native raw mouse delta summary', {
          slotPeerId,
          rawMovesSent: rawPerfRef.current.sent,
        });
        rawPerfRef.current.sent = 0;
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlistenDelta = fn;
    }).catch(() => {});

    void listen('remote-control-raw-lock-lost', () => {
      if (disposed) return;
      rawLockDesiredRef.current = false;
      rawLockGenRef.current += 1;
      pointerLockedRef.current = false;
      setPointerLocked(false);
      pendingDeltaRef.current = { x: 0, y: 0 };
      if (!hostMouseLockedRef.current && manualMouseLockRef.current) {
        manualMouseLockRef.current = false;
        setMouseLockOverride('auto');
      }
      updateHoldTracking(true);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenLost = fn;
    }).catch(() => {});

    return () => {
      disposed = true;
      unlistenDelta?.();
      unlistenLost?.();
      releasePointerLock();
    };
  }, [active, releasePointerLock, slotPeerId, updateHoldTracking]);

  useEffect(() => {
    if (!isTauri() || !active || !pointerLocked || !wantPointerLock) return;
    const syncRect = () => {
      if (pointerLockedRef.current && wantPointerLockRef.current) {
        tryAcquirePointerLock();
      }
    };
    const video = videoRef.current;
    const ro = video && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncRect) : null;
    if (ro && video) ro.observe(video);
    window.addEventListener('resize', syncRect);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', syncRect);
    };
  }, [active, pointerLocked, tryAcquirePointerLock, videoRef, wantPointerLock]);

  useEffect(() => {
    if (isTauri()) return;
    const container = containerRef.current;
    if (!active || !container) return;
    const onPointerLockChange = () => {
      const lockedNow = document.pointerLockElement === container;
      pointerLockedRef.current = lockedNow;
      setPointerLocked(lockedNow);
      if (lockedNow) {
        lockPausedByEscapeRef.current = false;
        setPointerInside(true);
      } else {
        if (programmaticUnlockRef.current) {
          programmaticUnlockRef.current = false;
        } else {
          lockPausedByEscapeRef.current = true;
          if (!hostMouseLockedRef.current && manualMouseLockRef.current) {
            manualMouseLockRef.current = false;
            setMouseLockOverride('auto');
          }
        }
        pendingDeltaRef.current = { x: 0, y: 0 };
      }
      updateHoldTracking();
    };
    const onPointerLockError = () => {
      // Chromium rejects Pointer Lock outside a fresh user activation; next mousedown/keydown retries.
      pointerLockedRef.current = document.pointerLockElement === container;
      setPointerLocked(pointerLockedRef.current);
    };
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('pointerlockerror', onPointerLockError);
    return () => {
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      document.removeEventListener('pointerlockerror', onPointerLockError);
      releasePointerLock();
    };
  }, [active, containerRef, releasePointerLock, updateHoldTracking]);

  useEffect(() => {
    if (!wantPointerLock) {
      if (!hostMouseLocked && !manualMouseLock) {
        lockPausedByEscapeRef.current = false;
      }
      releasePointerLock();
      return;
    }
    if (isTauri()) {
      if (pointerInsideRef.current || manualMouseLock || effectiveMouseLock) {
        tryAcquirePointerLock();
      }
      return;
    }
    if (!lockPausedByEscapeRef.current && (pointerInsideRef.current || manualMouseLock)) {
      tryAcquirePointerLock();
    }
  }, [effectiveMouseLock, hostMouseLocked, manualMouseLock, releasePointerLock, tryAcquirePointerLock, wantPointerLock]);

  // Keep OS low-level immersive hook steady while active + immersive + focused; avoid churning on hostBusy transitions.
  const hookLive = active && immersive && windowFocused;
  useEffect(() => {
    if (!isTauri()) return;
    void invoke('set_remote_control_immersive', { enabled: hookLive }).catch(() => {});
    const nav = navigator as Navigator & {
      keyboard?: { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };
    };
    if ((hookLive || (active && windowFocused && pointerLocked)) && document.fullscreenElement) {
      void nav.keyboard?.lock?.(['Escape']).catch(() => {});
    } else {
      try { nav.keyboard?.unlock?.(); } catch {}
    }
    return () => {
      if (hookLive) {
        void invoke('set_remote_control_immersive', { enabled: false }).catch(() => {});
      }
      try { nav.keyboard?.unlock?.(); } catch {}
    };
  }, [active, hookLive, pointerLocked, windowFocused]);

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

    const flushPendingDelta = () => {
      clearTrailingMoveTimer();
      const dx = Math.trunc(pendingDeltaRef.current.x);
      const dy = Math.trunc(pendingDeltaRef.current.y);
      if (dx === 0 && dy === 0) return;
      pendingDeltaRef.current.x -= dx;
      pendingDeltaRef.current.y -= dy;
      const now = performance.now();
      lastMoveSentRef.current = now;
      hadActiveInputRef.current = true;
      perfMovesSent += 1;
      roomService.sendRemoteControlInput(slotPeerId, { kind: 'mouseDelta', dx, dy });
      maybeLogInputPerf(now);
    };

    const flushPendingMove = () => {
      clearTrailingMoveTimer();
      if (isMouseLockedNow()) {
        if (!isTauri()) flushPendingDelta();
        return;
      }
      const next = pendingMoveRef.current;
      if (!next) return;
      pendingMoveRef.current = null;
      lastSentPosRef.current = next;
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

    const syncLiveFocus = () => {
      const focused = !document.hidden && document.hasFocus();
      if (focused !== windowFocusedRef.current) {
        windowFocusedRef.current = focused;
        setWindowFocused(focused);
      }
      return focused;
    };

    const handlePointerDown = (event: PointerEvent) => {
      syncLiveFocus();
      clearStuckOverlayHover(event.target);
      if (isMouseLockedNow()) {
        if (wantPointerLockRef.current) lockPausedByEscapeRef.current = false;
        return;
      }
      if (!isVideoInteractionTarget(event.target, container) || overlayHoveredRef.current) return;
      if (!getPos(event.clientX, event.clientY)) return;
      if (wantPointerLockRef.current) {
        lockPausedByEscapeRef.current = false;
        tryAcquirePointerLock();
        if (isMouseLockedNow()) return;
      }
      activePointerIdRef.current = event.pointerId;
      try {
        container.setPointerCapture(event.pointerId);
      } catch {}
    };

    const handlePointerMove = (event: PointerEvent) => {
      const liveFocused = syncLiveFocus();
      if (isMouseLockedNow()) {
        // On Tauri Windows, WM_INPUT delivers hardware raw deltas independently of DOM pointermove.
        if (isTauri()) return;
        if (!liveFocused || document.hidden) return;
        if (!pointerInsideRef.current) setPointerInside(true);
        if (hostBusyRef.current || !mouseEnabledRef.current || overlayHoveredRef.current) return;
        const dx = Number.isFinite(event.movementX) ? event.movementX : 0;
        const dy = Number.isFinite(event.movementY) ? event.movementY : 0;
        if (dx === 0 && dy === 0) return;
        pendingDeltaRef.current.x += dx;
        pendingDeltaRef.current.y += dy;
        const now = performance.now();
        if (now - lastMoveSentRef.current >= MIN_MOVE_INTERVAL_MS) {
          flushPendingDelta();
        } else {
          perfMovesCoalesced += 1;
          if (trailingMoveTimerRef.current === null) {
            trailingMoveTimerRef.current = window.setTimeout(
              flushPendingDelta,
              MIN_MOVE_INTERVAL_MS,
            );
          }
        }
        return;
      }

      const holding = hasActiveHold();
      if (!holding) {
        clearStuckOverlayHover(event.target);
        if (!isVideoInteractionTarget(event.target, container) || document.hidden || overlayHoveredRef.current) {
          if (pointerInsideRef.current) setPointerInside(false);
          return;
        }
      } else if (!liveFocused) {
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
      if (isTauri() && wantPointerLockRef.current) {
        tryAcquirePointerLock();
      }
      if (hostBusyRef.current || !mouseEnabledRef.current) return;
      const lastSent = lastSentPosRef.current;
      if (lastSent && pos.x === lastSent.x && pos.y === lastSent.y) {
        return;
      }
      const now = performance.now();
      const elapsed = now - lastMoveSentRef.current;
      if (elapsed >= MIN_MOVE_INTERVAL_MS) {
        clearTrailingMoveTimer();
        pendingMoveRef.current = null;
        lastSentPosRef.current = pos;
        lastMoveSentRef.current = now;
        hadActiveInputRef.current = true;
        perfMovesSent += 1;
        roomService.sendRemoteControlInput(slotPeerId, { kind: 'mouseMove', x: pos.x, y: pos.y });
        maybeLogInputPerf(now);
      } else {
        pendingMoveRef.current = pos;
        perfMovesCoalesced += 1;
        if (trailingMoveTimerRef.current === null) {
          trailingMoveTimerRef.current = window.setTimeout(
            flushPendingMove,
            MIN_MOVE_INTERVAL_MS,
          );
        }
      }
    };

    const handlePointerLeave = () => {
      if (isMouseLockedNow() || hasActiveHold()) return;
      if (pointerInsideRef.current) setPointerInside(false);
      sendReleaseAll();
    };

    const handleMouseDown = (event: MouseEvent) => {
      syncLiveFocus();
      clearStuckOverlayHover(event.target);
      const locked = isMouseLockedNow();
      if (!locked && (!isVideoInteractionTarget(event.target, container) || overlayHoveredRef.current)) return;
      const pos = locked ? null : getPos(event.clientX, event.clientY);
      if (!locked && !pos) return;
      if (!locked && wantPointerLockRef.current) {
        lockPausedByEscapeRef.current = false;
        tryAcquirePointerLock();
      }
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
        ...(pos && !isMouseLockedNow() ? { x: pos.x, y: pos.y } : {}),
      });
    };

    const handleMouseUp = (event: MouseEvent) => {
      clearStuckOverlayHover(event.target);
      const locked = isMouseLockedNow();
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
      const insideTarget = locked || (isVideoInteractionTarget(event.target, container) && !overlayHoveredRef.current);
      if (!wasHeld && !insideTarget) return;
      if (!button || hostBusyRef.current || !mouseEnabledRef.current) return;
      const pos = locked
        ? null
        : wasHeld
          ? getClampedPos(event.clientX, event.clientY)
          : getPos(event.clientX, event.clientY);
      if (!locked && !insideTarget && !getPos(event.clientX, event.clientY) && !hasActiveHold()) {
        setPointerInside(false);
      }
      event.preventDefault();
      event.stopPropagation();
      flushPendingMove();
      hadActiveInputRef.current = true;
      roomService.sendRemoteControlInput(slotPeerId, {
        kind: 'mouseButton',
        button,
        down: false,
        ...(pos ? { x: pos.x, y: pos.y } : {}),
      });
    };

    const handleContextMenu = (event: MouseEvent) => {
      const locked = isMouseLockedNow();
      if (!locked && !isVideoInteractionTarget(event.target, container) && !hasActiveHold()) return;
      if (!locked && overlayHoveredRef.current && !hasActiveHold()) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleWheel = (event: WheelEvent) => {
      syncLiveFocus();
      clearStuckOverlayHover(event.target);
      const locked = isMouseLockedNow();
      if (!locked && (!isVideoInteractionTarget(event.target, container) || overlayHoveredRef.current)) return;
      const pos = locked ? null : getPos(event.clientX, event.clientY);
      if (!locked && !pos) return;
      event.preventDefault();
      event.stopPropagation();
      if (hostBusyRef.current || !mouseEnabledRef.current) return;
      const multiplier = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? 400 : 1;
      hadActiveInputRef.current = true;
      roomService.sendRemoteControlInput(slotPeerId, {
        kind: 'mouseWheel',
        deltaX: event.deltaX * multiplier,
        deltaY: event.deltaY * multiplier,
        ...(pos ? { x: pos.x, y: pos.y } : {}),
      });
    };

    const handleKey = (event: KeyboardEvent, down: boolean) => {
      const codeKey = event.code || event.key;
      const wasHeld = !down && codeKey ? heldKeysRef.current.has(codeKey) : false;
      const liveFocused = syncLiveFocus();
      if (
        down &&
        !event.repeat &&
        event.ctrlKey &&
        event.shiftKey &&
        event.code === 'KeyM' &&
        liveFocused &&
        !isTextInputElement(event.target) &&
        (isMouseLockedNow() || pointerInsideRef.current || immersiveRef.current)
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (isMouseLockedNow()) {
          sendReleaseAll();
        }
        toggleManualMouseLock();
        return;
      }
      if (!keyboardEnabledRef.current || hostBusyRef.current || !liveFocused) {
        return;
      }
      if (!wasHeld) {
        const allowScope =
          isMouseLockedNow() ||
          pointerInsideRef.current ||
          hasActiveHold() ||
          (immersiveRef.current && !isTextInputElement(event.target));
        if (!allowScope || (overlayHoveredRef.current && !immersiveRef.current && !hasActiveHold() && !isMouseLockedNow())) {
          return;
        }
        if (immersiveRef.current ? isTextInputElement(event.target) : isEditableTarget(event.target)) {
          return;
        }
      }
      event.preventDefault();
      event.stopPropagation();
      if (
        down &&
        event.code !== 'Escape' &&
        wantPointerLockRef.current &&
        !lockPausedByEscapeRef.current &&
        !isMouseLockedNow() &&
        !isEditableTarget(event.target)
      ) {
        tryAcquirePointerLock();
      }
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
      releasePointerLock();
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
        releasePointerLock();
        sendReleaseAll();
      }
    };

    container.addEventListener('pointerdown', handlePointerDown);
    container.addEventListener('pointerrawupdate', handlePointerMove as EventListener);
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
      clearTrailingMoveTimer();
      container.classList.remove('is-remote-control-active');
      video.classList.remove('is-remote-control-active');
      if (!hadTabIndex) container.removeAttribute('tabindex');
      container.removeEventListener('pointerdown', handlePointerDown);
      container.removeEventListener('pointerrawupdate', handlePointerMove as EventListener);
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
      releasePointerLock();
      sendReleaseAll();
    };
  }, [active, clearTrailingMoveTimer, containerRef, hasActiveHold, isMouseLockedNow, releasePointerLock, sendReleaseAll, slotPeerId, toggleManualMouseLock, tryAcquirePointerLock, updateHoldTracking, videoRef]);

  const activeImageId = cursorSync?.imageId || '';
  const activeCursorAsset = activeImageId ? cursorImages?.[activeImageId] : undefined;
  const resolvedCursorShape = cursorSync?.active ? cursorSync.cursorShape : cursorShape;
  const cssCursorValue = useMemo(() => {
    if (!activeCursorAsset) return resolvedCursorShape;
    return `url("${activeCursorAsset.dataUrl}") ${activeCursorAsset.hotX} ${activeCursorAsset.hotY}, ${resolvedCursorShape}`;
  }, [activeCursorAsset, resolvedCursorShape]);

  const cursorCss =
    active && !hostBusy && !overlayHovered && !overlayMenuOpen && mouseEnabled
      ? pointerLocked
        ? 'none'
        : pointerInside || holdingInput
          ? cssCursorValue
          : undefined
      : undefined;

  return {
    status,
    pending,
    active,
    hostBusy,
    mouseEnabled,
    keyboardEnabled,
    cursorCaptured,
    cursorShape: resolvedCursorShape,
    immersive,
    mouseLocked: effectiveMouseLock || pointerLocked,
    manualMouseLock,
    pointerLocked,
    pointerInside,
    cursorCss,
    toggleRequest,
    exit,
    toggleImmersive,
    toggleManualMouseLock,
    setOverlayHovered,
    setOverlayMenuOpen,
  };
}
