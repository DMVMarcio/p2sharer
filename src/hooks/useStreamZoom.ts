import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clampPanOffset,
  clampZoom,
  calculateFocalZoom,
  stepZoom,
  PanOffset,
} from '../components/room/zoom_utils';

export interface UseStreamZoomReturn {
  zoom: number;
  pan: PanOffset;
  isDragging: boolean;
  didDragRef: React.MutableRefObject<boolean>;
  setZoomDirect: (newZoom: number) => void;
  stepZoomLevel: (direction: 1 | -1) => void;
  resetZoom: () => void;
  handleMouseDown: (e: React.MouseEvent) => void;
  handleDoubleClick: (e: React.MouseEvent) => void;
}

export function useStreamZoom(
  cardRef: React.RefObject<HTMLDivElement | null>,
  stream: MediaStream | null | undefined,
  enabled: boolean = true
): UseStreamZoomReturn {
  const [zoom, setZoom] = useState<number>(1.0);
  const [pan, setPan] = useState<PanOffset>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const zoomRef = useRef<number>(zoom);
  zoomRef.current = zoom;

  const panRef = useRef<PanOffset>(pan);
  panRef.current = pan;

  const didDragRef = useRef<boolean>(false);
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    initialPanX: number;
    initialPanY: number;
    moved: boolean;
  } | null>(null);

  // Reset zoom whenever stream instance changes
  useEffect(() => {
    setZoom(1.0);
    setPan({ x: 0, y: 0 });
  }, [stream]);

  // Non-passive wheel listener for smooth focal-point zoom
  useEffect(() => {
    if (!enabled) return;
    const el = cardRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      // Don't intercept scroll inside tooltips or dropdowns
      if ((e.target as HTMLElement)?.closest('.watchers-tooltip, .custom-tooltip')) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const container = cardRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;

      // Handle both wheel and trackpad pinch-zoom (ctrlKey)
      const delta = e.ctrlKey ? -e.deltaY * 0.05 : -e.deltaY;
      const factor = delta > 0 ? 1.15 : 0.87;
      const target = zoomRef.current * factor;
      const nextZoom = target < 1.05 ? 1.0 : clampZoom(target);

      const result = calculateFocalZoom({
        currentZoom: zoomRef.current,
        nextZoom,
        cursorX,
        cursorY,
        containerWidth: rect.width,
        containerHeight: rect.height,
        currentPan: panRef.current,
      });

      setZoom(result.zoom);
      setPan(result.pan);
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', handleWheel);
    };
  }, [cardRef, enabled]);

  // Touch pinch-to-zoom and pan support for mobile devices
  useEffect(() => {
    if (!enabled) return;
    const el = cardRef.current;
    if (!el) return;

    let initialPinchDistance: number | null = null;
    let initialPinchZoom = 1.0;
    let pinchCenter = { x: 0, y: 0 };
    let singleTouchState: {
      startX: number;
      startY: number;
      initialPanX: number;
      initialPanY: number;
      moved: boolean;
    } | null = null;
    let lastTapTime = 0;

    const handleTouchStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('button, input, textarea, a, select, [role="button"], .stream-controls-group, .stream-zoom-bar, .stream-card-stats-hud')) {
        return;
      }

      if (e.touches.length === 2) {
        // Pinch-to-zoom start
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        initialPinchDistance = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        initialPinchZoom = zoomRef.current;
        const rect = el.getBoundingClientRect();
        pinchCenter = {
          x: (t1.clientX + t2.clientX) / 2 - rect.left,
          y: (t1.clientY + t2.clientY) / 2 - rect.top,
        };
        singleTouchState = null;
      } else if (e.touches.length === 1) {
        const now = Date.now();
        if (now - lastTapTime < 300 && zoomRef.current > 1.0) {
          // Double-tap reset
          setZoom(1.0);
          setPan({ x: 0, y: 0 });
          lastTapTime = 0;
          return;
        }
        lastTapTime = now;

        if (zoomRef.current > 1.0) {
          singleTouchState = {
            startX: e.touches[0].clientX,
            startY: e.touches[0].clientY,
            initialPanX: panRef.current.x,
            initialPanY: panRef.current.y,
            moved: false,
          };
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && initialPinchDistance !== null) {
        e.preventDefault();
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const currentDistance = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        if (initialPinchDistance > 0) {
          const scale = currentDistance / initialPinchDistance;
          const targetZoom = clampZoom(initialPinchZoom * scale);
          const nextZoom = targetZoom < 1.05 ? 1.0 : targetZoom;

          const rect = el.getBoundingClientRect();
          const result = calculateFocalZoom({
            currentZoom: zoomRef.current,
            nextZoom,
            cursorX: pinchCenter.x,
            cursorY: pinchCenter.y,
            containerWidth: rect.width,
            containerHeight: rect.height,
            currentPan: panRef.current,
          });

          setZoom(result.zoom);
          setPan(result.pan);
        }
      } else if (e.touches.length === 1 && singleTouchState && zoomRef.current > 1.0) {
        const dx = e.touches[0].clientX - singleTouchState.startX;
        const dy = e.touches[0].clientY - singleTouchState.startY;
        if (!singleTouchState.moved && Math.hypot(dx, dy) > 5) {
          singleTouchState.moved = true;
          setIsDragging(true);
        }
        if (singleTouchState.moved) {
          e.preventDefault();
          const width = el.clientWidth || 0;
          const height = el.clientHeight || 0;
          const nextPan = clampPanOffset(
            { x: singleTouchState.initialPanX + dx, y: singleTouchState.initialPanY + dy },
            zoomRef.current,
            width,
            height
          );
          setPan(nextPan);
        }
      }
    };

    const handleTouchEnd = () => {
      initialPinchDistance = null;
      if (singleTouchState?.moved) {
        didDragRef.current = true;
        setTimeout(() => {
          didDragRef.current = false;
        }, 100);
      }
      setIsDragging(false);
      singleTouchState = null;
    };

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    el.addEventListener('touchend', handleTouchEnd);
    el.addEventListener('touchcancel', handleTouchEnd);

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
      el.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [cardRef, enabled]);

  const setZoomDirect = useCallback(
    (newZoom: number) => {
      const targetZoom = clampZoom(newZoom);
      if (targetZoom <= 1.0) {
        setZoom(1.0);
        setPan({ x: 0, y: 0 });
        return;
      }
      const container = cardRef.current;
      const width = container?.clientWidth || 0;
      const height = container?.clientHeight || 0;
      const clampedPan = clampPanOffset(panRef.current, targetZoom, width, height);
      setZoom(targetZoom);
      setPan(clampedPan);
    },
    [cardRef]
  );

  const stepZoomLevel = useCallback(
    (direction: 1 | -1) => {
      const next = stepZoom(zoomRef.current, direction);
      setZoomDirect(next);
    },
    [setZoomDirect]
  );

  const resetZoom = useCallback(() => {
    setZoom(1.0);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!enabled || zoomRef.current <= 1.0 || e.button !== 0) return;

      const target = e.target as HTMLElement;
      if (
        target.closest(
          'button, input, a, .stream-zoom-bar, .stream-volume-controller, .stream-card-stats-hud, .btn-stop-watch-stream'
        )
      ) {
        return;
      }

      dragStateRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        initialPanX: panRef.current.x,
        initialPanY: panRef.current.y,
        moved: false,
      };

      setIsDragging(true);

      const onMouseMove = (moveEvent: MouseEvent) => {
        const state = dragStateRef.current;
        if (!state) return;

        const dx = moveEvent.clientX - state.startX;
        const dy = moveEvent.clientY - state.startY;

        if (!state.moved && Math.hypot(dx, dy) > 3) {
          state.moved = true;
        }

        if (state.moved) {
          const container = cardRef.current;
          const width = container?.clientWidth || 0;
          const height = container?.clientHeight || 0;
          const nextPan = clampPanOffset(
            { x: state.initialPanX + dx, y: state.initialPanY + dy },
            zoomRef.current,
            width,
            height
          );
          setPan(nextPan);
        }
      };

      const onMouseUp = () => {
        setIsDragging(false);
        if (dragStateRef.current?.moved) {
          didDragRef.current = true;
          setTimeout(() => {
            didDragRef.current = false;
          }, 100);
        }
        dragStateRef.current = null;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [cardRef, enabled]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!enabled) return;
      const target = e.target as HTMLElement;
      if (
        target.closest(
          'button, input, a, .stream-zoom-bar, .stream-volume-controller, .stream-card-stats-hud'
        )
      ) {
        return;
      }
      if (zoomRef.current > 1.0) {
        e.stopPropagation();
        resetZoom();
      }
    },
    [enabled, resetZoom]
  );

  return {
    zoom,
    pan,
    isDragging,
    didDragRef,
    setZoomDirect,
    stepZoomLevel,
    resetZoom,
    handleMouseDown,
    handleDoubleClick,
  };
}
