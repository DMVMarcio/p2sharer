import React, { useCallback, useState } from 'react';

export type PlanningColor = 'green' | 'amber' | 'sky' | 'rose';

export interface PlanningArrow {
  from: number;
  to: number;
  via?: number | null;
  color: PlanningColor;
}

export interface PlanningHighlight {
  square: number;
  color: PlanningColor;
}

const COLOR_STROKE: Record<PlanningColor, string> = {
  green: 'rgba(118, 206, 86, 0.88)',
  amber: 'rgba(244, 179, 62, 0.9)',
  sky: 'rgba(78, 184, 236, 0.88)',
  rose: 'rgba(235, 92, 92, 0.88)',
};

function colorFromModifiers(event: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): PlanningColor {
  if (event.shiftKey) return 'amber';
  if (event.altKey) return 'sky';
  if (event.ctrlKey || event.metaKey) return 'rose';
  return 'green';
}

export function useBoardPlanning(gridSize = 8) {
  const [arrows, setArrows] = useState<PlanningArrow[]>([]);
  const [highlights, setHighlights] = useState<PlanningHighlight[]>([]);
  const [draftArrow, setDraftArrow] = useState<PlanningArrow | null>(null);

  const clearPlanning = useCallback(() => {
    setArrows([]);
    setHighlights([]);
    setDraftArrow(null);
  }, []);

  const squareCenter = useCallback(
    (sq: number) => {
      const r = Math.floor(sq / gridSize);
      const c = sq % gridSize;
      return { x: c + 0.5, y: r + 0.5 };
    },
    [gridSize],
  );

  const pickBestVia = useCallback(
    (from: number, to: number, visited: number[]): number | null => {
      if (from === to) return null;
      const a = squareCenter(from);
      const b = squareCenter(to);
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const len = Math.hypot(vx, vy);
      if (len < 0.01) return null;

      let bestSq: number | null = null;
      let bestDist = 0.55; // Threshold so straight-line drags don't accidentally curve

      for (const sq of visited) {
        if (sq === from || sq === to) continue;
        const p = squareCenter(sq);
        // Perpendicular distance from p to line segment a->b
        const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / (len * len);
        if (t <= 0.05 || t >= 0.95) continue;
        const projX = a.x + t * vx;
        const projY = a.y + t * vy;
        const dist = Math.hypot(p.x - projX, p.y - projY);
        if (dist > bestDist) {
          bestDist = dist;
          bestSq = sq;
        }
      }
      return bestSq;
    },
    [squareCenter],
  );

  const resolveSquareFromPoint = (clientX: number, clientY: number): number | null => {
    const el = document.elementFromPoint(clientX, clientY);
    const cell = el?.closest<HTMLElement>('[data-board-square]');
    if (!cell) return null;
    const idx = Number(cell.dataset.boardSquare);
    return Number.isInteger(idx) && idx >= 0 && idx < gridSize * gridSize ? idx : null;
  };

  const startRightPlanning = useCallback(
    (event: React.PointerEvent<HTMLElement>, startSq: number) => {
      if (event.button !== 2) return;
      event.preventDefault();
      event.stopPropagation();

      const color = colorFromModifiers(event);
      const visited: number[] = [startSq];
      setDraftArrow({ from: startSq, to: startSq, via: null, color });

      const onMove = (moveEvent: PointerEvent) => {
        const hovered = resolveSquareFromPoint(moveEvent.clientX, moveEvent.clientY);
        if (hovered === null) return;
        if (visited[visited.length - 1] !== hovered) {
          visited.push(hovered);
        }
        const via = pickBestVia(startSq, hovered, visited);
        setDraftArrow({ from: startSq, to: hovered, via, color });
      };

      const onUp = (upEvent: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);

        const endSq = resolveSquareFromPoint(upEvent.clientX, upEvent.clientY) ?? visited[visited.length - 1];
        setDraftArrow(null);

        if (endSq === startSq) {
          setHighlights((prev) => {
            const exists = prev.some((h) => h.square === startSq && h.color === color);
            if (exists) return prev.filter((h) => !(h.square === startSq && h.color === color));
            return [...prev.filter((h) => h.square !== startSq), { square: startSq, color }];
          });
          return;
        }

        const via = pickBestVia(startSq, endSq, visited);
        setArrows((prev) => {
          const exists = prev.some(
            (a) => a.from === startSq && a.to === endSq && (a.via ?? null) === (via ?? null) && a.color === color,
          );
          if (exists) {
            return prev.filter(
              (a) => !(a.from === startSq && a.to === endSq && (a.via ?? null) === (via ?? null) && a.color === color),
            );
          }
          return [
            ...prev.filter((a) => !(a.from === startSq && a.to === endSq)),
            { from: startSq, to: endSq, via, color },
          ];
        });
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [gridSize, pickBestVia],
  );

  return {
    arrows,
    highlights,
    draftArrow,
    clearPlanning,
    startRightPlanning,
  };
}

function renderArrowShape(
  arrow: PlanningArrow,
  gridSize: number,
  flipped: boolean,
  isDraft: boolean,
  key: string,
) {
  if (arrow.from === arrow.to) return null;

  const toVisualCenter = (sq: number) => {
    const r = Math.floor(sq / gridSize);
    const c = sq % gridSize;
    const vr = flipped ? gridSize - 1 - r : r;
    const vc = flipped ? gridSize - 1 - c : c;
    return { x: vc * 100 + 50, y: vr * 100 + 50, r: vr, c: vc };
  };

  const start = toVisualCenter(arrow.from);
  const end = toVisualCenter(arrow.to);
  const stroke = COLOR_STROKE[arrow.color];

  const dr = Math.abs(end.r - start.r);
  const dc = Math.abs(end.c - start.c);
  const isKnightJump = gridSize === 8 && ((dr === 2 && dc === 1) || (dr === 1 && dc === 2));

  let pathD = '';
  let tipAngle = Math.atan2(end.y - start.y, end.x - start.x);
  const headLen = 28;
  const headHalfWidth = 22;

  if (arrow.via !== null && arrow.via !== undefined && arrow.via !== arrow.from && arrow.via !== arrow.to) {
    // Smooth user-drawn curved arrow passing near `via`
    const mid = toVisualCenter(arrow.via);
    const ctrlX = 2 * mid.x - 0.5 * (start.x + end.x);
    const ctrlY = 2 * mid.y - 0.5 * (start.y + end.y);

    const startDirAngle = Math.atan2(ctrlY - start.y, ctrlX - start.x);
    const sx = start.x + Math.cos(startDirAngle) * 18;
    const sy = start.y + Math.sin(startDirAngle) * 18;

    tipAngle = Math.atan2(end.y - ctrlY, end.x - ctrlX);
    const ex = end.x - Math.cos(tipAngle) * (headLen * 0.72);
    const ey = end.y - Math.sin(tipAngle) * (headLen * 0.72);

    pathD = `M ${sx} ${sy} Q ${ctrlX} ${ctrlY} ${ex} ${ey}`;
  } else if (isKnightJump) {
    // Classic L-shaped curved knight arrow
    const elbowX = dr === 2 ? start.x : end.x;
    const elbowY = dr === 2 ? end.y : start.y;

    const firstAngle = Math.atan2(elbowY - start.y, elbowX - start.x);
    const secondAngle = Math.atan2(end.y - elbowY, end.x - elbowX);
    tipAngle = secondAngle;

    const sx = start.x + Math.cos(firstAngle) * 18;
    const sy = start.y + Math.sin(firstAngle) * 18;
    const ex = end.x - Math.cos(secondAngle) * (headLen * 0.72);
    const ey = end.y - Math.sin(secondAngle) * (headLen * 0.72);

    const cornerRadius = 24;
    const preX = elbowX - Math.cos(firstAngle) * cornerRadius;
    const preY = elbowY - Math.sin(firstAngle) * cornerRadius;
    const postX = elbowX + Math.cos(secondAngle) * cornerRadius;
    const postY = elbowY + Math.sin(secondAngle) * cornerRadius;

    pathD = `M ${sx} ${sy} L ${preX} ${preY} Q ${elbowX} ${elbowY} ${postX} ${postY} L ${ex} ${ey}`;
  } else {
    // Straight arrow
    const sx = start.x + Math.cos(tipAngle) * 18;
    const sy = start.y + Math.sin(tipAngle) * 18;
    const ex = end.x - Math.cos(tipAngle) * (headLen * 0.72);
    const ey = end.y - Math.sin(tipAngle) * (headLen * 0.72);
    pathD = `M ${sx} ${sy} L ${ex} ${ey}`;
  }

  // Arrowhead triangle anchored neatly at `end`
  const tipX = end.x;
  const tipY = end.y;
  const baseLeftX = tipX - Math.cos(tipAngle) * headLen + Math.sin(tipAngle) * headHalfWidth;
  const baseLeftY = tipY - Math.sin(tipAngle) * headLen - Math.cos(tipAngle) * headHalfWidth;
  const baseRightX = tipX - Math.cos(tipAngle) * headLen - Math.sin(tipAngle) * headHalfWidth;
  const baseRightY = tipY - Math.sin(tipAngle) * headLen + Math.cos(tipAngle) * headHalfWidth;

  return (
    <g key={key} opacity={isDraft ? 0.65 : 0.92}>
      <path
        d={pathD}
        fill="none"
        stroke={stroke}
        strokeWidth={16}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polygon
        points={`${tipX},${tipY} ${baseLeftX},${baseLeftY} ${baseRightX},${baseRightY}`}
        fill={stroke}
      />
    </g>
  );
}

export const BoardPlanningOverlay: React.FC<{
  gridSize?: number;
  flipped: boolean;
  arrows: PlanningArrow[];
  highlights: PlanningHighlight[];
  draftArrow: PlanningArrow | null;
}> = ({ gridSize = 8, flipped, arrows, highlights, draftArrow }) => {
  if (arrows.length === 0 && highlights.length === 0 && !draftArrow) return null;

  const size = gridSize * 100;

  return (
    <svg
      className="board-planning-overlay"
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      {highlights.map((h) => {
        const r = Math.floor(h.square / gridSize);
        const c = h.square % gridSize;
        const vr = flipped ? gridSize - 1 - r : r;
        const vc = flipped ? gridSize - 1 - c : c;
        return (
          <circle
            key={`hl-${h.square}-${h.color}`}
            cx={vc * 100 + 50}
            cy={vr * 100 + 50}
            r={41}
            fill="none"
            stroke={COLOR_STROKE[h.color]}
            strokeWidth={7}
          />
        );
      })}
      {arrows.map((a) => renderArrowShape(a, gridSize, flipped, false, `arr-${a.from}-${a.to}-${a.via ?? 's'}`))}
      {draftArrow && renderArrowShape(draftArrow, gridSize, flipped, true, 'draft-arrow')}
    </svg>
  );
};
