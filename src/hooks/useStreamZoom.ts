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
  stream: MediaStream | null | undefined
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
  }, [cardRef]);

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
      if (zoomRef.current <= 1.0 || e.button !== 0) return;

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
    [cardRef]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
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
    [resetZoom]
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
