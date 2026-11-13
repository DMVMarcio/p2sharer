import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Keyboard, Maximize2, Minimize2, Mouse, Power, ShieldAlert, Volume1, Volume2, VolumeX } from 'lucide-react';
import logoUrl from '../../assets/logo.png';
import { useLocale } from '../../hooks/useLocale';
import { t } from '../../i18n';

interface RemoteControlFloatingOverlayProps {
  containerRef: RefObject<HTMLElement | null>;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onExitRemoteControl: () => void;
  immersive: boolean;
  onToggleImmersive: () => void;
  hostBusy: boolean;
  mouseEnabled: boolean;
  keyboardEnabled: boolean;
  volume: number;
  isMuted: boolean;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
  onOverlayHoverChange: (hovered: boolean) => void;
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
  hostBusy,
  mouseEnabled,
  keyboardEnabled,
  volume,
  isMuted,
  onVolumeChange,
  onToggleMute,
  onOverlayHoverChange,
}: RemoteControlFloatingOverlayProps) {
  useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const syncBounds = () => {
      const rect = container.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      setContainerSize({ width: rect.width, height: rect.height });
      setPos((prev) =>
        prev
          ? clampPos(prev.x, prev.y, rect.width, rect.height)
          : clampPos(rect.width - PILL_SIZE - EDGE_MARGIN, EDGE_MARGIN, rect.width, rect.height),
      );
    };

    syncBounds();
    const observer = new ResizeObserver(syncBounds);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);

  useEffect(() => {
    if (!open) return;
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

    const container = containerRef.current;
    if (!container || !pos) return;
    const containerRect = container.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const initialPos = pos;
    let moved = false;

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!moved && Math.hypot(dx, dy) >= 5) {
        moved = true;
        setDragging(true);
      }
      if (moved) {
        setPos(clampPos(initialPos.x + dx, initialPos.y + dy, containerRect.width, containerRect.height));
      }
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      setDragging(false);
      if (!moved) {
        setOpen((prev) => !prev);
      }
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  };

  const resolvedPos = pos ?? { x: EDGE_MARGIN, y: EDGE_MARGIN };
  const alignRight = containerSize.width > 0 && resolvedPos.x > containerSize.width / 2;
  const openUpward = containerSize.height > 0 && resolvedPos.y > containerSize.height / 2;

  return (
    <div
      ref={rootRef}
      className={`remote-control-floating-overlay ${dragging ? 'is-dragging' : ''} ${open ? 'is-open' : ''} ${hostBusy ? 'is-host-busy' : ''}`}
      style={{ transform: `translate3d(${resolvedPos.x}px, ${resolvedPos.y}px, 0)` }}
      onMouseEnter={() => onOverlayHoverChange(true)}
      onMouseLeave={() => onOverlayHoverChange(false)}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <button
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
