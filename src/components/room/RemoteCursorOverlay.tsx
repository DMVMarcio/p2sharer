import { useEffect, useState, type RefObject } from 'react';
import type { RemoteCursorShape, RemoteCursorSyncState } from '../../core/remote_control';
import { streamPointerVideoRect } from '../../core/stream_pointer';

interface RemoteCursorOverlayProps {
  containerRef: RefObject<HTMLElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  cursorSync: RemoteCursorSyncState | undefined;
  visible: boolean;
  viewKey?: string;
}

interface OverlayBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

function getHotspotOffset(shape: RemoteCursorShape): [number, number] {
  if (shape === 'default') return [4, 3];
  if (shape === 'pointer') return [7, 2];
  return [12, 12];
}

function renderCursorSvg(shape: RemoteCursorShape) {
  switch (shape) {
    case 'pointer':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M8.5 3.5a1.5 1.5 0 0 1 3 0v6h1a1.5 1.5 0 0 1 1.5 1.5v.3a1.5 1.5 0 0 1 2 .2v.3a1.5 1.5 0 0 1 2 1.4v3.1a5 5 0 0 1-5 5h-1.8a4.5 4.5 0 0 1-4.1-2.7l-1.9-4.3a1.4 1.4 0 0 1 2.4-1.3l.9 1.1V3.5Z"
            fill="#ffffff"
            stroke="#111827"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'text':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 5h6M9 19h6M12 5v14" fill="none" stroke="#111827" strokeWidth="3.2" strokeLinecap="round" />
          <path d="M9.5 5h5M9.5 19h5M12 5v14" fill="none" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case 'crosshair':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4v16M4 12h16" fill="none" stroke="#111827" strokeWidth="3.2" strokeLinecap="round" />
          <path d="M12 4.5v15M4.5 12h15" fill="none" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case 'move':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 3l2.5 2.5h-1.5v5.5h5.5V9.5L21 12l-2.5 2.5V13h-5.5v5.5h1.5L12 21l-2.5-2.5H11V13H5.5v1.5L3 12l2.5-2.5V11H11V5.5H9.5L12 3z"
            fill="#ffffff"
            stroke="#111827"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'ns-resize':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 3l3 3.5h-2v11h2L12 21l-3-3.5h2v-11H9L12 3z"
            fill="#ffffff"
            stroke="#111827"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'ew-resize':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M3 12l3.5-3v2h11V9l3.5 3-3.5 3v-2h-11v2L3 12z"
            fill="#ffffff"
            stroke="#111827"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'nwse-resize':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M5 5h5.2L8.5 6.7l8.8 8.8L19 13.8V19h-5.2l1.7-1.7-8.8-8.8L5 10.2V5z"
            fill="#ffffff"
            stroke="#111827"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'nesw-resize':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M19 5v5.2l-1.7-1.7-8.8 8.8L10.2 19H5v-5.2l1.7 1.7 8.8-8.8L13.8 5H19z"
            fill="#ffffff"
            stroke="#111827"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'not-allowed':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7.5" fill="#ffffff" stroke="#111827" strokeWidth="1.8" />
          <line x1="7.5" y1="7.5" x2="16.5" y2="16.5" stroke="#dc2626" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      );
    case 'wait':
    case 'progress':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7.5" fill="#ffffff" stroke="#111827" strokeWidth="1.8" />
          <path d="M12 8v4.5l3 1.5" fill="none" stroke="#111827" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'default':
    default:
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M4 3l14 9.5-6.2 1.2 3.1 6-2.3 1.1-3.1-6-5.5 4.2V3z"
            fill="#ffffff"
            stroke="#111827"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

export function RemoteCursorOverlay({
  containerRef,
  videoRef,
  cursorSync,
  visible,
  viewKey = '',
}: RemoteCursorOverlayProps) {
  const [bounds, setBounds] = useState<OverlayBounds | null>(null);

  useEffect(() => {
    if (!visible) {
      setBounds(null);
      return;
    }
    const container = containerRef.current;
    const video = videoRef.current;
    if (!container || !video) return;

    const update = () => {
      const containerRect = container.getBoundingClientRect();
      const rect = streamPointerVideoRect(video.getBoundingClientRect(), video.videoWidth, video.videoHeight);
      if (!rect || rect.width < 2 || rect.height < 2) {
        setBounds(null);
        return;
      }
      const next: OverlayBounds = {
        left: rect.left - containerRect.left,
        top: rect.top - containerRect.top,
        width: rect.width,
        height: rect.height,
      };
      setBounds((prev) =>
        prev &&
        Math.abs(prev.left - next.left) < 0.5 &&
        Math.abs(prev.top - next.top) < 0.5 &&
        Math.abs(prev.width - next.width) < 0.5 &&
        Math.abs(prev.height - next.height) < 0.5
          ? prev
          : next,
      );
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(video);
    video.addEventListener('resize', update);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      video.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
    };
  }, [containerRef, videoRef, visible, viewKey]);

  if (!visible || !cursorSync || !bounds) return null;

  const pxX = bounds.left + cursorSync.x * bounds.width;
  const pxY = bounds.top + cursorSync.y * bounds.height;
  const [hotX, hotY] = getHotspotOffset(cursorSync.cursorShape);

  return (
    <div
      className="remote-cursor-overlay"
      aria-hidden="true"
      style={{
        transform: `translate3d(${pxX - hotX}px, ${pxY - hotY}px, 0)`,
      }}
    >
      {renderCursorSvg(cursorSync.cursorShape)}
    </div>
  );
}
