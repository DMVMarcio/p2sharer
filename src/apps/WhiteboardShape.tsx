import { memo } from 'react';
import { brushPath, hasVariablePressure, shapeOpacity, shapeTransform, type BoardShape } from './whiteboard_scene';

export const WhiteboardShape = memo(function WhiteboardShape({ shape: s, imageHref, ignoreOpacity = false }: {
  shape: BoardShape; imageHref?: string; ignoreOpacity?: boolean;
}) {
  const [a, b = a] = s.points;
  const opacity = ignoreOpacity ? 1 : shapeOpacity(s);
  const transform = shapeTransform(s);
  if (s.tool === 'image') {
    if (!imageHref) return null;
    return <image href={imageHref} x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)}
      preserveAspectRatio="none" opacity={opacity < 1 ? opacity : undefined} transform={transform} />;
  }
  if (s.tool === 'brush' || s.tool === 'eraser' || s.tool === 'line') {
    const d = brushPath(s);
    if (hasVariablePressure(s)) {
      if (s.tool === 'brush' && s.brushType === 'brush') {
        return <g opacity={opacity < 1 ? opacity : undefined}>
          <path fill="none" stroke={s.color} strokeWidth={Math.round(s.width * 22) / 100} strokeOpacity={0.3} strokeLinecap="round" strokeLinejoin="round" transform={transform} d={d} />
          <path fill={s.color} stroke="none" transform={transform} d={d} />
        </g>;
      }
      return <path fill={s.color} stroke="none" opacity={opacity < 1 ? opacity : undefined} transform={transform} d={d} />;
    }
    const width = s.tool === 'brush' && s.brushType === 'pencil' ? Math.max(1, Math.round(s.width * 72) / 100) : s.width;
    const dash = s.tool === 'brush' && s.brushType === 'pencil' ? `${Math.round(Math.max(1, s.width * 0.2) * 100) / 100} ${Math.round(Math.max(0.5, s.width * 0.06) * 100) / 100}` : undefined;
    if (s.tool === 'brush' && s.brushType === 'brush') {
      return <g opacity={opacity < 1 ? opacity : undefined}>
        <path stroke={s.color} strokeWidth={Math.round(s.width * 120) / 100} strokeOpacity={0.3} fill="none" strokeLinecap="round" strokeLinejoin="round" transform={transform} d={d} />
        <path stroke={s.color} strokeWidth={Math.round(s.width * 88) / 100} fill="none" strokeLinecap="round" strokeLinejoin="round" transform={transform} d={d} />
      </g>;
    }
    return <path stroke={s.color} strokeWidth={width} fill="none" opacity={opacity < 1 ? opacity : undefined} strokeDasharray={dash}
      strokeLinecap="round" strokeLinejoin="round" transform={transform} d={d} />;
  }
  const props = { stroke: s.color, strokeWidth: s.width, fill: s.filled ? s.color : 'none',
    opacity: opacity < 1 ? opacity : undefined, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, transform };
  if (s.tool === 'rectangle') return <rect {...props} x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} />;
  return <ellipse {...props} cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} rx={Math.abs(b.x - a.x) / 2} ry={Math.abs(b.y - a.y) / 2} />;
});
