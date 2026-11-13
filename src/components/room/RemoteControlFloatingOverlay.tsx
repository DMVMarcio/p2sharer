import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Eye, Keyboard, Maximize2, Minimize2, Mouse, Power, ShieldAlert, Volume1, Volume2, VolumeX } from 'lucide-react';
import logoUrl from '../../assets/logo.png';
import { useLocale } from '../../hooks/useLocale';
import { getLanguage, t } from '../../i18n';

interface RemoteControlFloatingOverlayProps {
  containerRef: RefObject<HTMLElement | null>;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onExitRemoteControl: () => void;
  immersive: boolean;
  onToggleImmersive: () => void;
  localCursor: boolean;
  onToggleLocalCursor: () => void;
  hostBusy: boolean;
  mouseEnabled: boolean;
  keyboardEnabled: boolean;
  volume: number;
  isMuted: boolean;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
  onOverlayHoverChange: (hovered: boolean) => void;
  qualityText: string;
  liveBitrateKbps: number;
  configuredBitrateKbps: number;
  pingText?: string;
  pingClass?: 'ping-good' | 'ping-medium' | 'ping-poor';
  transportTag?: string;
  watchersCount?: number;
}

const PILL_SIZE = 42;
const EDGE_MARGIN = 16;

function clampPos(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const maxX = Math.max(EDGE_MARGIN, width - PILL_SIZE - EDGE_MARGIN);
  const maxY = Math.max(EDGE_MARGIN, height - PILL_SIZE - EDGE_MARGIN);
  return {
    x: Math.max(EDGE_MARGIN, Math.min(maxX, x)),
    y: Math.max(EDGE_MARGIN, Math.min(maxY, y)),
  };
}

export function RemoteControlFloatingOverlay({
  containerRef,
  isFullscreen,
  onToggleFullscreen,
  onExitRemoteControl,
  immersive,
  onToggleImmersive,
  localCursor,
  onToggleLocalCursor,
  hostBusy,
  mouseEnabled,
  keyboardEnabled,
  volume,
  isMuted,
  onVolumeChange,
  onToggleMute,
  onOverlayHoverChange,
  qualityText,
  liveBitrateKbps,
  configuredBitrateKbps,
  pingText,
  pingClass,
  transportTag = '',
  watchersCount = 0,
}: RemoteControlFloatingOverlayProps) {
  useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const onOverlayHoverChangeRef = useRef(onOverlayHoverChange);
  onOverlayHoverChangeRef.current = onOverlayHoverChange;

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);

  const syncBounds = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    setContainerSize({ width: rect.width, height: rect.height });
    setPos((prev) =>
      prev
        ? clampPos(prev.x, prev.y, rect.width, rect.height)
        : clampPos(rect.width - PILL_SIZE - EDGE_MARGIN, EDGE_MARGIN, rect.width, rect.height),
    );
  }, [containerRef]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    syncBounds();
    const observer = new ResizeObserver(syncBounds);
    observer.observe(container);
    const onFullscreenOrResize = () => {
      syncBounds();
      requestAnimationFrame(syncBounds);
      onOverlayHoverChangeRef.current(false);
    };
    window.addEventListener('resize', onFullscreenOrResize);
    document.addEventListener('fullscreenchange', onFullscreenOrResize);
    document.addEventListener('webkitfullscreenchange', onFullscreenOrResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onFullscreenOrResize);
      document.removeEventListener('fullscreenchange', onFullscreenOrResize);
      document.removeEventListener('webkitfullscreenchange', onFullscreenOrResize);
    };
  }, [containerRef, isFullscreen, syncBounds]);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      onOverlayHoverChangeRef.current(false);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      onOverlayHoverChangeRef.current(false);
      return;
    }
    const handleOutside = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', handleOutside, true);
    return () => window.removeEventListener('pointerdown', handleOutside, true);
  }, [open]);

  const handlePillPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    dragCleanupRef.current?.();
    dragCleanupRef.current = null;

    const container = containerRef.current;
    if (!container) return;
    const initialRect = container.getBoundingClientRect();
    const initialPos = pos ?? clampPos(
      Math.max(EDGE_MARGIN, initialRect.width - PILL_SIZE - EDGE_MARGIN),
      EDGE_MARGIN,
      Math.max(PILL_SIZE + EDGE_MARGIN * 2, initialRect.width),
      Math.max(PILL_SIZE + EDGE_MARGIN * 2, initialRect.height),
    );
    if (!pos && initialRect.width && initialRect.height) {
      setContainerSize({ width: initialRect.width, height: initialRect.height });
      setPos(initialPos);
    }

    const pointerId = event.pointerId;
    const pillEl = event.currentTarget;
    try {
      pillEl.setPointerCapture(pointerId);
    } catch {}

    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('blur', onCancel);
      pillEl.removeEventListener('lostpointercapture', onCancel);
      try {
        if (pillEl.hasPointerCapture?.(pointerId)) {
          pillEl.releasePointerCapture(pointerId);
        }
      } catch {}
      setDragging(false);
      if (dragCleanupRef.current === cleanup) {
        dragCleanupRef.current = null;
      }
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!moved && Math.hypot(dx, dy) >= 5) {
        moved = true;
        setDragging(true);
      }
      if (moved) {
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || initialRect.width;
        const height = rect?.height || initialRect.height;
        if (width && height) {
          setContainerSize({ width, height });
          setPos(clampPos(initialPos.x + dx, initialPos.y + dy, width, height));
        }
      }
    };

    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      cleanup();
      if (!moved) {
        setOpen((prev) => !prev);
      }
    };

    const onCancel = (cancelEvent?: Event) => {
      if (cancelEvent && 'pointerId' in cancelEvent && (cancelEvent as PointerEvent).pointerId !== pointerId) {
        return;
      }
      cleanup();
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('blur', onCancel);
    pillEl.addEventListener('lostpointercapture', onCancel);
  };

  const resolvedPos = pos ?? { x: EDGE_MARGIN, y: EDGE_MARGIN };
  const alignRight = containerSize.width > 0 && resolvedPos.x > containerSize.width / 2;
  const openUpward = containerSize.height > 0 && resolvedPos.y > containerSize.height / 2;
  const availableHorizontal = containerSize.width > 0
    ? (alignRight ? resolvedPos.x + PILL_SIZE - EDGE_MARGIN : containerSize.width - resolvedPos.x - EDGE_MARGIN)
    : undefined;
  const panelInlineMaxWidth = availableHorizontal !== undefined
    ? Math.max(200, Math.min(312, availableHorizontal))
    : undefined;
  const availableVertical = containerSize.height > 0
    ? (openUpward ? resolvedPos.y - EDGE_MARGIN - 8 : containerSize.height - resolvedPos.y - PILL_SIZE - EDGE_MARGIN - 8)
    : undefined;
  const panelInlineMaxHeight = availableVertical !== undefined
    ? Math.max(150, availableVertical)
    : undefined;
  const liveBitrateText = `${(liveBitrateKbps / 1000).toLocaleString(getLanguage(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} Mbps`;
  const configuredBitrateValue = (configuredBitrateKbps / 1000).toLocaleString(getLanguage(), {
    maximumFractionDigits: 0,
  });

  return (
    <div
      ref={rootRef}
      className={`remote-control-floating-overlay ${dragging ? 'is-dragging' : ''} ${open ? 'is-open' : ''} ${hostBusy ? 'is-host-busy' : ''}`}
      style={{ transform: `translate3d(${resolvedPos.x}px, ${resolvedPos.y}px, 0)` }}
      onPointerEnter={() => onOverlayHoverChange(true)}
      onPointerLeave={() => onOverlayHoverChange(false)}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onPointerCancel={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <button
        ref={pillRef}
        type="button"
        className="remote-control-floating-pill"
        aria-label={t('remoteControl.floatingMenuLabel')}
        aria-expanded={open}
        onPointerDown={handlePillPointerDown}
      >
        <img src={logoUrl} alt="" className="remote-control-floating-logo" draggable={false} />
        {immersive && <span className="remote-control-floating-dot is-immersive" aria-hidden="true" />}
        {hostBusy && <span className="remote-control-floating-dot is-busy" aria-hidden="true" />}
      </button>

      {open && (
        <div
          className={`remote-control-floating-panel ${alignRight ? 'align-right' : 'align-left'} ${openUpward ? 'open-upward' : 'open-downward'}`}
          style={{
            ...(panelInlineMaxWidth ? { maxWidth: `${panelInlineMaxWidth}px` } : {}),
            ...(panelInlineMaxHeight ? { maxHeight: `${panelInlineMaxHeight}px`, overflowY: 'auto' } : {}),
          }}
          role="dialog"
          aria-label={t('remoteControl.floatingMenuLabel')}
        >
          <div className="remote-control-floating-header">
            <span className="remote-control-floating-title">{t('remoteControl.activeTitle')}</span>
            {hostBusy && (
              <span className="remote-control-floating-badge is-busy">
                <ShieldAlert size={12} aria-hidden="true" />
                {t('remoteControl.hostPriorityActive')}
              </span>
            )}
          </div>

          <div className="remote-control-floating-stats">
            <span className="stat-badge stat-badge-quality">
              <span className="stat-badge-dot" />
              <span className="stat-quality-text">{qualityText}</span>
            </span>
            <span className="stat-badge stat-badge-bitrate">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
              <span className="stat-bitrate-text">
                {liveBitrateKbps > 0 ? liveBitrateText : `${configuredBitrateValue} Mbps`}
              </span>
            </span>
            {pingText && pingClass && (
              <span className="stat-badge stat-badge-ping">
                <span className={`stat-ping-dot ${pingClass}`} />
                <span className="stat-ping-text">{pingText}{transportTag}</span>
              </span>
            )}
            {watchersCount > 0 && (
              <span className="stat-badge stat-badge-watchers">
                <Eye size={11} aria-hidden="true" />
                <span className="stat-watchers-text">{watchersCount}</span>
              </span>
            )}
          </div>

          {(!mouseEnabled || !keyboardEnabled) && (
            <div className="remote-control-floating-restrictions">
              {!mouseEnabled && (
                <span>
                  <Mouse size={12} aria-hidden="true" />
                  {t('remoteControl.mouseDisabledHint')}
                </span>
              )}
              {!keyboardEnabled && (
                <span>
                  <Keyboard size={12} aria-hidden="true" />
                  {t('remoteControl.keyboardDisabledHint')}
                </span>
              )}
            </div>
          )}

          <label className="remote-control-floating-row remote-control-immersive-row">
            <span className="remote-control-floating-row-copy">
              <strong>{t('remoteControl.immersiveMode')}</strong>
              <small>{t('remoteControl.immersiveHint')}</small>
            </span>
            <span className="modern-switch">
              <input
                type="checkbox"
                autoComplete="off"
                checked={immersive}
                onChange={onToggleImmersive}
                aria-label={t('remoteControl.immersiveMode')}
              />
              <span className="switch-slider" />
            </span>
          </label>

          <label className="remote-control-floating-row">
            <span className="remote-control-floating-row-copy">
              <strong>{t('remoteControl.localCursor')}</strong>
              <small>{t('remoteControl.localCursorHint')}</small>
            </span>
            <span className="modern-switch">
              <input
                type="checkbox"
                autoComplete="off"
                checked={localCursor}
                onChange={onToggleLocalCursor}
                aria-label={t('remoteControl.localCursor')}
              />
              <span className="switch-slider" />
            </span>
          </label>

          <div className="remote-control-floating-volume">
            <button
              type="button"
              className="btn-stream-pin"
              onClick={onToggleMute}
              aria-label={isMuted ? t('message.5cfebda5d336') : t('message.70f507f2963f')}
            >
              {isMuted || volume === 0 ? (
                <VolumeX size={14} aria-hidden="true" />
              ) : volume < 50 ? (
                <Volume1 size={14} aria-hidden="true" />
              ) : (
                <Volume2 size={14} aria-hidden="true" />
              )}
            </button>
            <input
              type="range"
              autoComplete="off"
              min={0}
              max={100}
              value={isMuted ? 0 : volume}
              className="remote-control-volume-range"
              aria-label={t('message.78ba36d6b04f')}
              onChange={(event) => onVolumeChange(Number(event.target.value))}
            />
            <span className="remote-control-volume-pct">{isMuted ? '0%' : `${volume}%`}</span>
          </div>

          <div className="remote-control-floating-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setOpen(false);
                onToggleFullscreen();
              }}
            >
              {isFullscreen ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
              <span>{isFullscreen ? t('message.1ea619b7211d') : t('message.1dfa15614e9a')}</span>
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => {
                setOpen(false);
                onExitRemoteControl();
              }}
            >
              <Power size={14} aria-hidden="true" />
              <span>{t('remoteControl.exitAction')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
