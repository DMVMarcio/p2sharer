import { memo, useId } from 'react';
import { brushPath, expandSymmetryPointLists, hasVariablePressure, shapeOpacity, shapeTransform, type BoardShape } from './whiteboard_scene';

export const WhiteboardShape = memo(function WhiteboardShape({
  shape: s,
  imageHref,
  ignoreOpacity = false,
  canvasWidth = 1920,
  canvasHeight = 1080,
}: {
  shape: BoardShape;
  imageHref?: string;
  ignoreOpacity?: boolean;
  canvasWidth?: number;
  canvasHeight?: number;
}) {
  const uid = useId();
  const [a, b = a] = s.points;
  const opacity = ignoreOpacity ? 1 : shapeOpacity(s);
  const transform = shapeTransform(s);
  const clipId = s.clipPolygon?.length ? `${uid}-clip` : undefined;
  const wrapClip = (node: React.ReactNode) => clipId && s.clipPolygon ? (
    <g>
      <defs>
        <clipPath id={clipId}>
          <polygon points={s.clipPolygon.map(p => `${p.x},${p.y}`).join(' ')} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>{node}</g>
    </g>
  ) : node;

  if (s.tool === 'clear') {
    if (s.clipPolygon?.length) {
      return <polygon points={s.clipPolygon.map(p => `${p.x},${p.y}`).join(' ')} fill="#000000" transform={transform} />;
    }
    return <rect x={-16000} y={-10000} width={48000} height={30000} fill="#000000" />;
  }
  if (s.tool === 'bucket') {
    if (s.clipPolygon?.length) {
      return <polygon points={s.clipPolygon.map(p => `${p.x},${p.y}`).join(' ')} fill={s.color} opacity={opacity < 1 ? opacity : undefined} transform={transform} />;
    }
    if (s.points.length === 2) {
      return <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)}
        fill={s.color} opacity={opacity < 1 ? opacity : undefined} transform={transform} />;
    }
    return <rect x={0} y={0} width={canvasWidth} height={canvasHeight} fill={s.color} opacity={opacity < 1 ? opacity : undefined} transform={transform} />;
  }
  if (s.tool === 'gradient') {
    const gradId = `${uid}-grad`;
    const endColor = s.gradientTransparent ? s.color : (s.secondaryColor ?? '#ffffff');
    const endOpacity = s.gradientTransparent ? 0 : 1;
    return wrapClip(
      <g>
        <defs>
          {s.gradientType === 'radial' ? (
            <radialGradient id={gradId} gradientUnits="userSpaceOnUse" cx={a.x} cy={a.y} r={Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))}>
              <stop offset="0%" stopColor={s.color} stopOpacity={1} />
              <stop offset="100%" stopColor={endColor} stopOpacity={endOpacity} />
            </radialGradient>
          ) : (
            <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1={a.x} y1={a.y} x2={b.x} y2={b.y}>
              <stop offset="0%" stopColor={s.color} stopOpacity={1} />
              <stop offset="100%" stopColor={endColor} stopOpacity={endOpacity} />
            </linearGradient>
          )}
        </defs>
        <rect x={0} y={0} width={canvasWidth} height={canvasHeight} fill={`url(#${gradId})`} opacity={opacity < 1 ? opacity : undefined} transform={transform} />
      </g>
    );
  }
  if (s.tool === 'text') {
    const fontSize = s.fontSize ?? Math.max(14, s.width * 2);
    const lines = (s.text ?? '').split('\n');
    return wrapClip(
      <text x={a.x} y={a.y} fill={s.color} fontSize={fontSize} fontWeight={s.fontBold ? 'bold' : 'normal'} fontStyle={s.fontItalic ? 'italic' : 'normal'}
        opacity={opacity < 1 ? opacity : undefined} transform={transform}>
        {lines.map((line, idx) => (
          <tspan key={idx} x={a.x} dy={idx === 0 ? fontSize : fontSize * 1.25}>{line}</tspan>
        ))}
      </text>
    );
  }
  if (s.tool === 'image') {
    if (!imageHref) return null;
    return wrapClip(
      <image href={imageHref} x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)}
        preserveAspectRatio="none" opacity={opacity < 1 ? opacity : undefined} transform={transform} />
    );
  }
  if (s.tool === 'brush' || s.tool === 'eraser' || s.tool === 'line') {
    const copies = expandSymmetryPointLists(s.points, s.symmetry, canvasWidth / 2, canvasHeight / 2);
    return wrapClip(
      <>
        {copies.map((pts, idx) => {
          const subShape: BoardShape = { ...s, points: pts };
          const d = brushPath(subShape);
          if (hasVariablePressure(subShape)) {
            return <path key={idx} fill={s.color} fillRule="nonzero" stroke="none" opacity={opacity < 1 ? opacity : undefined} transform={transform} d={d} />;
          }
          return <path key={idx} stroke={s.color} strokeWidth={s.width} fill="none" opacity={opacity < 1 ? opacity : undefined}
            strokeLinecap="round" strokeLinejoin="round" transform={transform} d={d} />;
        })}
      </>
    );
  }
  const props = {
    stroke: s.color,
    strokeWidth: s.width,
    fill: s.filled ? s.color : 'none',
    opacity: opacity < 1 ? opacity : undefined,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    transform,
  };
  if (s.tool === 'rectangle') {
    return wrapClip(<rect {...props} x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} />);
  }
  return wrapClip(<ellipse {...props} cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} rx={Math.abs(b.x - a.x) / 2} ry={Math.abs(b.y - a.y) / 2} />);
});
