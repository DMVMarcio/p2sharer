import { memo } from 'react';
import { brushPath, type BoardShape } from './whiteboard_scene';

export const WhiteboardShape = memo(function WhiteboardShape({ shape: s }: { shape: BoardShape }) {
  const [a, b = a] = s.points;
  const props = { stroke: s.color, strokeWidth: s.width, fill: s.filled && s.tool !== 'brush' && s.tool !== 'line' ? s.color : 'none',
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, transform: `translate(${s.x} ${s.y})` };
  if (s.tool === 'brush' || s.tool === 'line') return <path {...props} d={brushPath(s)} />;
  if (s.tool === 'rectangle') return <rect {...props} x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} />;
  return <ellipse {...props} cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} rx={Math.abs(b.x - a.x) / 2} ry={Math.abs(b.y - a.y) / 2} />;
});
