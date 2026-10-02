import { useEffect, useRef, useState } from 'react';
import type { StreamDrawing, StreamPointerVisual } from '../../core/stream_pointer';

/** One normalized projection for native desktop, video cards, zoom, and PiP. */
export function StreamDrawingLayer({ visuals, bounds, draft }: {
  visuals: StreamPointerVisual[]; bounds?: { left: number; top: number; width: number; height: number };
  draft?: StreamDrawing | null;
}) {
  const root = useRef<SVGSVGElement>(null);
  const [nativeSize, setNativeSize] = useState({ width: 1, height: 1 });
  useEffect(() => {
    if (bounds || !root.current) return;
    const observer = new ResizeObserver(([entry]) => setNativeSize(entry.contentRect));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [!!bounds]);
  const { width, height } = bounds ?? nativeSize;
  const scale = Math.min(width, height) / 1080;
  const drawings = visuals.filter(v => v.drawing).map(v => ({ id: v.id, drawing: v.drawing! }));
  if (draft) drawings.push({ id: 'draft', drawing: draft });
  return <svg ref={root} className="stream-drawing-layer" style={bounds && { left: bounds.left, top: bounds.top, width, height }}
    viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
    {drawings.map(({ id, drawing: d }) => {
      const points = d.points.map(p => ({ x: p.x * width, y: p.y * height }));
      const a = points[0], b = points[points.length - 1];
      const strokeWidth = (d.tool === 'brush' ? 2 + d.size * 3 : 1 + d.size) * scale;
      const common = { stroke: d.color, strokeWidth, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
      if (d.tool === 'text') return <text key={id} x={a.x} y={a.y} fill={d.color} fontSize={(14 + d.size * 5) * scale} dominantBaseline="hanging">{d.text}</text>;
      if (d.tool === 'rectangle') return <rect key={id} {...common} x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} />;
      if (d.tool === 'ellipse') return <ellipse key={id} {...common} cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} rx={Math.abs(b.x - a.x) / 2} ry={Math.abs(b.y - a.y) / 2} />;
      return points.length === 1 ? <circle key={id} cx={a.x} cy={a.y} r={strokeWidth / 2} fill={d.color} />
        : <polyline key={id} {...common} points={points.map(p => `${p.x},${p.y}`).join(' ')} />;
    })}
  </svg>;
}
