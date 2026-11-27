import { memo, useId } from 'react';
import {
  brushPath, chiselMarkerPath, expandSymmetryPointLists, gPenCalligraphicPath,
  hasVariablePressure, pixelArtPath, shapeOpacity, shapeTransform, type BoardShape,
} from './whiteboard_scene';

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
          <polygon points={s.clipPolygon.map(p => `${p.x},${p.y}`).join(' ')} clipRule="evenodd" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>{node}</g>
    </g>
  ) : node;

  if (s.tool === 'clear') {
    if (s.clipPolygon?.length) {
      return <polygon points={s.clipPolygon.map(p => `${p.x},${p.y}`).join(' ')} fill="#000000" fillRule="evenodd" transform={transform} />;
    }
    return <rect x={-16000} y={-10000} width={48000} height={30000} fill="#000000" />;
  }
  if (s.tool === 'bucket') {
    if (s.clipPolygon?.length) {
      return <polygon points={s.clipPolygon.map(p => `${p.x},${p.y}`).join(' ')} fill={s.color} fillRule="evenodd" opacity={opacity < 1 ? opacity : undefined} transform={transform} />;
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
    const ix = Math.min(a.x, b.x), iy = Math.min(a.y, b.y);
    const iw = Math.abs(b.x - a.x), ih = Math.abs(b.y - a.y);
    const cx = ix + iw / 2, cy = iy + ih / 2;
    const flipTransform = s.flipX || s.flipY
      ? `${transform} translate(${cx} ${cy}) scale(${s.flipX ? -1 : 1} ${s.flipY ? -1 : 1}) translate(${-cx} ${-cy})`
      : transform;
    return wrapClip(
      <image href={imageHref} x={ix} y={iy} width={iw} height={ih}
        preserveAspectRatio="none" opacity={opacity < 1 ? opacity : undefined} transform={flipTransform} />
    );
  }
  if (s.tool === 'brush' || s.tool === 'eraser' || s.tool === 'line') {
    const copies = expandSymmetryPointLists(s.points, s.symmetry, canvasWidth / 2, canvasHeight / 2);
    const hardness = s.hardness ?? 80;
    const extraBlur = hardness < 65 ? Math.round(((65 - hardness) / 65) * Math.max(1, s.width * 0.18) * 10) / 10 : 0;

    return wrapClip(
      <>
        {copies.map((pts, idx) => {
          const subShape: BoardShape = { ...s, points: pts };
          const d = brushPath(subShape);

          if (s.tool === 'eraser' || s.tool === 'line') {
            if (hasVariablePressure(subShape)) {
              return <path key={idx} fill={s.color} fillRule="nonzero" stroke="none" opacity={opacity < 1 ? opacity : undefined} transform={transform} d={d} />;
            }
            return <path key={idx} stroke={s.color} strokeWidth={s.width} fill="none" opacity={opacity < 1 ? opacity : undefined}
              strokeLinecap="round" strokeLinejoin="round" transform={transform} d={d} />;
          }

          // 1. Pixel Art Brush: crisp integer-grid Bresenham staircase blocks
          if (s.brushType === 'pixel') {
            const pd = pixelArtPath(subShape);
            return (
              <path
                key={idx}
                fill={s.color}
                stroke="none"
                opacity={opacity < 1 ? opacity : undefined}
                style={{ shapeRendering: 'crispEdges' }}
                transform={transform}
                d={pd}
              />
            );
          }

          // 2. Chisel Marker: angled -35° calligraphic nib ribbon with multiply ink blending
          if (s.brushType === 'marker') {
            const md = chiselMarkerPath(subShape);
            return (
              <path
                key={idx}
                fill={s.color}
                fillRule="nonzero"
                stroke="none"
                opacity={Math.round(opacity * 0.72 * 1000) / 1000}
                style={{ mixBlendMode: 'multiply' }}
                transform={transform}
                d={md}
              />
            );
          }

          // 3. G-Pen (Ink Pen): razor-sharp calligraphic contour with tapered entry/exit nib
          if (s.brushType === 'pen') {
            const penD = hasVariablePressure(subShape) ? d : gPenCalligraphicPath(subShape);
            return (
              <path
                key={idx}
                fill={s.color}
                fillRule="nonzero"
                stroke="none"
                opacity={opacity < 1 ? opacity : undefined}
                style={extraBlur > 0.3 ? { filter: `blur(${extraBlur}px)` } : undefined}
                transform={transform}
                d={penD}
              />
            );
          }

          // 4. Graphite Pencil: dry paper-tooth grain filter + sketchy graphite core
          if (s.brushType === 'pencil') {
            if (hasVariablePressure(subShape)) {
              return (
                <path
                  key={idx}
                  fill={s.color}
                  fillRule="nonzero"
                  stroke="none"
                  filter="url(#wb-filter-pencil)"
                  opacity={Math.round(opacity * 0.88 * 1000) / 1000}
                  transform={transform}
                  d={d}
                />
              );
            }
            return (
              <g key={idx} filter="url(#wb-filter-pencil)" opacity={Math.round(opacity * 0.88 * 1000) / 1000} transform={transform}>
                <path stroke={s.color} strokeWidth={Math.max(1, s.width * 0.9)} fill="none" strokeLinecap="round" strokeLinejoin="round" d={d} />
              </g>
            );
          }

          // 5. Soft Airbrush: 3-ring radial Gaussian cloud spray with zero hard outline
          if (s.brushType === 'airbrush') {
            const bOuter = Math.max(3, Math.round(s.width * 0.42 * 10) / 10);
            const bMid = Math.max(2, Math.round(s.width * 0.24 * 10) / 10);
            const bCore = Math.max(1.2, Math.round(s.width * 0.12 * 10) / 10);
            return (
              <g key={idx} transform={transform}>
                <path stroke={s.color} strokeWidth={s.width * 1.85} fill="none" strokeLinecap="round" strokeLinejoin="round"
                  opacity={Math.round(opacity * 0.16 * 1000) / 1000} style={{ filter: `blur(${bOuter}px)` }} d={d} />
                <path stroke={s.color} strokeWidth={s.width * 1.15} fill="none" strokeLinecap="round" strokeLinejoin="round"
                  opacity={Math.round(opacity * 0.26 * 1000) / 1000} style={{ filter: `blur(${bMid}px)` }} d={d} />
                <path stroke={s.color} strokeWidth={s.width * 0.55} fill="none" strokeLinecap="round" strokeLinejoin="round"
                  opacity={Math.round(opacity * 0.36 * 1000) / 1000} style={{ filter: `blur(${bCore}px)` }} d={d} />
              </g>
            );
          }

          // 6. Wet Watercolor: translucent multiply wash with wet pigment edge pooling & organic bleed
          if (s.brushType === 'watercolor') {
            const washBlur = Math.max(1, Math.round(s.width * 0.1 * 10) / 10);
            return (
              <g key={idx} filter="url(#wb-filter-watercolor)" style={{ mixBlendMode: 'multiply' }} transform={transform}>
                <path stroke={s.color} strokeWidth={s.width * 1.06} fill="none" strokeLinecap="round" strokeLinejoin="round"
                  opacity={Math.round(opacity * 0.24 * 1000) / 1000} d={d} />
                <path stroke={s.color} strokeWidth={Math.max(1, s.width * 0.88)} fill="none" strokeLinecap="round" strokeLinejoin="round"
                  opacity={Math.round(opacity * 0.44 * 1000) / 1000} style={{ filter: `blur(${washBlur}px)` }} d={d} />
              </g>
            );
          }

          // 7. Smudge (Color Blender): streaky feathered color pull
          if (s.brushType === 'smudge') {
            const smudgeBlur = Math.max(2, Math.round(s.width * 0.25 * 10) / 10);
            return (
              <g key={idx} transform={transform}>
                <path stroke={s.color} strokeWidth={s.width * 1.2} fill="none" strokeLinecap="round" strokeLinejoin="round"
                  opacity={Math.round(opacity * 0.45 * 1000) / 1000} style={{ filter: `blur(${smudgeBlur}px)` }} d={d} />
                <path stroke={s.color} strokeWidth={Math.max(1, s.width * 0.68)} fill="none" strokeLinecap="round" strokeLinejoin="round"
                  opacity={Math.round(opacity * 0.68 * 1000) / 1000} style={{ filter: `blur(${Math.max(1, smudgeBlur * 0.45)}px)` }} d={d} />
              </g>
            );
          }

          // 8. Blur (Softening Glaze): wide heavy Gaussian feather
          if (s.brushType === 'blur') {
            const blurRad = Math.max(3.5, Math.round(s.width * 0.48 * 10) / 10);
            return (
              <path
                key={idx}
                stroke={s.color}
                strokeWidth={s.width * 1.45}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={Math.round(opacity * 0.32 * 1000) / 1000}
                style={{ filter: `blur(${blurRad}px)` }}
                transform={transform}
                d={d}
              />
            );
          }

          // 9. Paint Brush ('brush' — Oil/Acrylic): soft outer bristle feather + saturated inner pigment core
          if (hasVariablePressure(subShape)) {
            return (
              <path
                key={idx}
                fill={s.color}
                fillRule="nonzero"
                stroke="none"
                opacity={opacity < 1 ? opacity : undefined}
                style={extraBlur > 0.3 ? { filter: `blur(${extraBlur}px)` } : undefined}
                transform={transform}
                d={d}
              />
            );
          }
          const bristleBlur = Math.max(0.8, Math.round((extraBlur + s.width * 0.12) * 10) / 10);
          return (
            <g key={idx} transform={transform}>
              <path stroke={s.color} strokeWidth={s.width * 1.08} fill="none" strokeLinecap="round" strokeLinejoin="round"
                opacity={Math.round(opacity * 0.38 * 1000) / 1000} style={{ filter: `blur(${bristleBlur}px)` }} d={d} />
              <path stroke={s.color} strokeWidth={Math.max(1, s.width * 0.76)} fill="none" strokeLinecap="round" strokeLinejoin="round"
                opacity={Math.round(opacity * 0.92 * 1000) / 1000} d={d} />
            </g>
          );
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
