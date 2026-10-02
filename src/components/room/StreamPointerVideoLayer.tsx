import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { streamPointerVideoRect } from '../../core/stream_pointer';
import { streamPointerView } from '../../services/stream_pointer_view';
import { StreamDrawingLayer } from './StreamDrawingLayer';
import { StreamPointerGlyph } from './StreamPointerGlyph';

export function StreamPointerVideoLayer({ container, video, peerId, local, draft }: {
  container: RefObject<HTMLDivElement | null>; video: RefObject<HTMLVideoElement | null>; peerId: string;
  local: { x: number; y: number } | null; draft?: import('../../core/stream_pointer').StreamDrawing | null;
}) {
  const scene = useSyncExternalStore(streamPointerView.subscribe, () => streamPointerView.get(peerId));
  const [bounds, setBounds] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const active = scene.visuals.some((v) => v.expires > now) || !!local || !!draft;
  useEffect(() => {
    if (!active) { setBounds(null); return; }
    const element = video.current, parent = container.current;
    if (!element || !parent) return;
    const measure = () => {
      const image = streamPointerVideoRect(element.getBoundingClientRect(), element.videoWidth, element.videoHeight);
      const rect = parent.getBoundingClientRect();
      setBounds(image ? { ...image, left: image.left - rect.left, top: image.top - rect.top } : null);
      setNow(Date.now());
    };
    const resize = new ResizeObserver(measure);
    resize.observe(element); resize.observe(parent);
    const mutation = new MutationObserver(measure);
    mutation.observe(element, { attributes: true, attributeFilter: ['style'] });
    element.addEventListener('loadedmetadata', measure);
    // Expire stale cursors even after a sender disconnects without a final snapshot.
    const timer = setInterval(measure, 100);
    measure();
    return () => { clearInterval(timer); resize.disconnect(); mutation.disconnect(); element.removeEventListener('loadedmetadata', measure); };
  }, [container, video, peerId, active]);
  return <div className="stream-pointer-video-layer" aria-hidden="true">
    {bounds && <StreamDrawingLayer visuals={scene.visuals.filter(v => v.expires > now)} bounds={bounds} draft={draft} />}
    {bounds && scene.visuals.filter((v) => v.expires > now && !v.drawing && (v.ping || v.peerId !== scene.localPeerId)).map((v) =>
      <StreamPointerGlyph key={v.id} name={v.name} color={v.color} ping={v.ping}
        style={{ left: bounds.left + v.x * bounds.width, top: bounds.top + v.y * bounds.height }} />)}
    {local && <StreamPointerGlyph name={scene.name} color={scene.color} interpolate={false} style={{ left: local.x, top: local.y }} />}
  </div>;
}
