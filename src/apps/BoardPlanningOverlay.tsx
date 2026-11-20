import React, { useCallback, useState } from 'react';

export type PlanningColor = 'green' | 'amber' | 'sky' | 'rose';

export interface PlanningArrow {
  /** Sequence of logical square indices: [from, ...cornerTiles, to] */
  waypoints: number[];
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

function colorFromModifiers(event: {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): PlanningColor {
  if (event.shiftKey) return 'amber';
  if (event.altKey) return 'sky';
  if (event.ctrlKey || event.metaKey) return 'rose';
  return 'green';
}

function squareCenterUnit(sq: number, gridSize: number): { x: number; y: number } {
  const r = Math.floor(sq / gridSize);
  const c = sq % gridSize;
  return { x: c + 0.5, y: r + 0.5 };
}

/**
 * Simplifies a dragged tile path into straight-line waypoints using Ramer-Douglas-Peucker.
 * Threshold 0.76 tile units keeps orthogonal and diagonal drags as single straight arrows
 * while preserving intentional tile corners (e.g. L-turns and multi-leg plans).
 */
function simplifyTilePath(visited: number[], gridSize: number, epsilon = 0.76): number[] {
  if (visited.length <= 2) return [...visited];

  const first = visited[0];
  const last = visited[visited.length - 1];
  const a = squareCenterUnit(first, gridSize);
  const b = squareCenterUnit(last, gridSize);
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len = Math.hypot(vx, vy);

  let maxDist = -1;
  let maxIndex = -1;

  for (let i = 1; i < visited.length - 1; i++) {
    const p = squareCenterUnit(visited[i], gridSize);
    let dist: number;
    if (len < 0.001) {
      dist = Math.hypot(p.x - a.x, p.y - a.y);
    } else {
      dist = Math.abs((p.x - a.x) * vy - (p.y - a.y) * vx) / len;
    }
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }

  if (maxDist > epsilon && maxIndex > 0) {
    const left = simplifyTilePath(visited.slice(0, maxIndex + 1), gridSize, epsilon);
    const right = simplifyTilePath(visited.slice(maxIndex), gridSize, epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

function waypointsKey(waypoints: number[]): string {
  return waypoints.join('-');
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

  const resolveSquareFromPoint = (clientX: number, clientY: number): number | null => {
    const el = document.elementFromPoint(clientX, clientY);
    const cell = el?.closest<HTMLElement>('[data-board-square]');
    if (!cell) return null;
    const idx = Number(cell.dataset.boardSquare);
    return Number.isInteger(idx) && idx >= 0 && idx < gridSize * gridSize ? idx : null;
  };

  const buildWaypoints = useCallback(
    (visited: number[], endSq: number): number[] => {
      const startSq = visited[0];
      if (endSq === startSq) return [startSq];
      // Trim trailing backtracks to endSq if user returned onto a square
      const path = [...visited];
      if (path[path.length - 1] !== endSq) {
        path.push(endSq);
      }
      const simplified = simplifyTilePath(path, gridSize);
      // Ensure adjacent duplicates are collapsed
      const deduped: number[] = [];
      for (const sq of simplified) {
        if (deduped[deduped.length - 1] !== sq) {
          deduped.push(sq);
        }
      }
      return deduped;
    },
    [gridSize],
  );

  const startRightPlanning = useCallback(
    (event: React.PointerEvent<HTMLElement>, startSq: number) => {
      if (event.button !== 2) return;
      event.preventDefault();
      event.stopPropagation();

      const color = colorFromModifiers(event);
      const visited: number[] = [startSq];
      setDraftArrow({ waypoints: [startSq], color });

      const onMove = (moveEvent: PointerEvent) => {
        const hovered = resolveSquareFromPoint(moveEvent.clientX, moveEvent.clientY);
        if (hovered === null) return;
        if (visited[visited.length - 1] !== hovered) {
          // If the user drags back to the previous tile, pop the tip so correcting direction feels natural
          if (visited.length >= 2 && visited[visited.length - 2] === hovered) {
            visited.pop();
          } else {
            visited.push(hovered);
          }
        }
        setDraftArrow({ waypoints: buildWaypoints(visited, hovered), color });
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

        const waypoints = buildWaypoints(visited, endSq);
        if (waypoints.length < 2) return;

        const targetKey = waypointsKey(waypoints);
        setArrows((prev) => {
          const exactSame = prev.some((a) => waypointsKey(a.waypoints) === targetKey && a.color === color);
          if (exactSame) {
            return prev.filter((a) => !(waypointsKey(a.waypoints) === targetKey && a.color === color));
          }
          return [
            ...prev.filter(
              (a) => !(a.waypoints[0] === waypoints[0] && a.waypoints[a.waypoints.length - 1] === endSq),
            ),
            { waypoints, color },
          ];
        });
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [buildWaypoints, gridSize],
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
  const { waypoints } = arrow;
  if (waypoints.length < 2) return null;
  if (waypoints[0] === waypoints[waypoints.length - 1] && waypoints.length === 2) return null;

  const toVisualCenter = (sq: number) => {
    const r = Math.floor(sq / gridSize);
    const c = sq % gridSize;
    const vr = flipped ? gridSize - 1 - r : r;
    const vc = flipped ? gridSize - 1 - c : c;
    return { x: vc * 100 + 50, y: vr * 100 + 50 };
  };

  const points = waypoints.map(toVisualCenter);
  const stroke = COLOR_STROKE[arrow.color];

  const headLen = 30;
  const headHalfWidth = 23;

  const first = points[0];
  const second = points[1];
  const startAngle = Math.atan2(second.y - first.y, second.x - first.x);
  const sx = first.x + Math.cos(startAngle) * 18;
  const sy = first.y + Math.sin(startAngle) * 18;

  const prevLast = points[points.length - 2];
  const last = points[points.length - 1];
  const tipAngle = Math.atan2(last.y - prevLast.y, last.x - prevLast.x);
  const ex = last.x - Math.cos(tipAngle) * (headLen * 0.8);
  const ey = last.y - Math.sin(tipAngle) * (headLen * 0.8);

  const segments: string[] = [`M ${sx} ${sy}`];
  for (let i = 1; i < points.length - 1; i++) {
    segments.push(`L ${points[i].x} ${points[i].y}`);
  }
  segments.push(`L ${ex} ${ey}`);
  const pathD = segments.join(' ');

  const tipX = last.x;
  const tipY = last.y;
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
    <svg className="board-planning-overlay" viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
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
      {arrows.map((a) => renderArrowShape(a, gridSize, flipped, false, `arr-${waypointsKey(a.waypoints)}-${a.color}`))}
      {draftArrow && renderArrowShape(draftArrow, gridSize, flipped, true, 'draft-arrow')}
    </svg>
  );
};
