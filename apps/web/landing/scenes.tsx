import { useEffect, useRef, type CSSProperties } from 'react';
import { useReducedMotion } from '../../../src/core/appearance_preferences';
import { useInView } from './motion';

/** Fictional room participants used across the landing page illustrations. */
export const PEERS = [
  { name: 'Ana', color: '#f472b6' },
  { name: 'Leo', color: '#38bdf8' },
  { name: 'Mia', color: '#a3e635' },
  { name: 'Theo', color: '#fbbf24' },
] as const;

export type Peer = (typeof PEERS)[number];

export function PeerAvatar({ peer, size = 28, speaking = false }: { peer: Peer; size?: number; speaking?: boolean }) {
  return (
    <span
      className={`lp-avatar${speaking ? ' is-speaking' : ''}`}
      style={{ '--peer': peer.color, '--size': `${size}px` } as CSSProperties}
      aria-hidden="true"
    >
      {peer.name[0]}
    </span>
  );
}

/** Stylized game artwork shown inside shared-screen illustrations. */
export function GameScene({ className = '' }: { className?: string }) {
  return (
    <svg className={`lp-game-scene ${className}`} viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="lp-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#312e81" />
          <stop offset="0.55" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#f472b6" />
        </linearGradient>
        <linearGradient id="lp-sun" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fde68a" />
          <stop offset="1" stopColor="#fb923c" />
        </linearGradient>
      </defs>
      <rect width="320" height="180" fill="url(#lp-sky)" />
      <circle className="lp-game-sun" cx="220" cy="92" r="34" fill="url(#lp-sun)" />
      <g className="lp-game-stars" fill="#fff">
        <circle cx="38" cy="22" r="1.2" /><circle cx="92" cy="40" r="1" /><circle cx="140" cy="16" r="1.4" />
        <circle cx="270" cy="28" r="1" /><circle cx="300" cy="54" r="1.2" /><circle cx="180" cy="34" r="0.9" />
      </g>
      <path d="M0 132 L48 96 L92 124 L150 82 L204 128 L262 100 L320 126 L320 180 L0 180 Z" fill="#4c1d95" opacity="0.9" />
      <path d="M0 150 L60 122 L118 146 L176 116 L236 150 L290 130 L320 140 L320 180 L0 180 Z" fill="#1e1b4b" />
      <g className="lp-game-grid" stroke="#f472b6" strokeOpacity="0.45" strokeWidth="1">
        <line x1="0" y1="166" x2="320" y2="166" />
        <line x1="0" y1="174" x2="320" y2="174" />
        <line x1="160" y1="150" x2="40" y2="180" />
        <line x1="160" y1="150" x2="280" y2="180" />
        <line x1="160" y1="150" x2="160" y2="180" />
      </g>
      <g className="lp-game-hud">
        <rect x="12" y="12" width="64" height="6" rx="3" fill="#000" opacity="0.35" />
        <rect className="lp-game-health" x="12" y="12" width="46" height="6" rx="3" fill="#34d399" />
        <rect x="12" y="22" width="40" height="4" rx="2" fill="#000" opacity="0.35" />
        <rect x="12" y="22" width="28" height="4" rx="2" fill="#38bdf8" />
      </g>
      <g className="lp-game-ship">
        <path d="M150 140 L160 120 L170 140 L160 135 Z" fill="#e0e7ff" />
        <circle cx="160" cy="142" r="3" fill="#fb923c" className="lp-game-flame" />
      </g>
    </svg>
  );
}

/** Animated live cursor with a participant label. */
export function LiveCursor({ peer, className = '' }: { peer: Peer; className?: string }) {
  return (
    <span className={`lp-cursor ${className}`} style={{ '--peer': peer.color } as CSSProperties} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="16" height="16"><path d="M2 1 L14 8 L8.5 9.2 L6 14.5 Z" /></svg>
      <span>{peer.name}</span>
    </span>
  );
}

/** Small equalizer used to show active audio. */
export function LevelMeter({ bars = 5, muted = false }: { bars?: number; muted?: boolean }) {
  return (
    <span className={`lp-meter${muted ? ' is-muted' : ''}`} aria-hidden="true">
      {Array.from({ length: bars }, (_, index) => (
        <i key={index} style={{ '--i': index } as CSSProperties} />
      ))}
    </span>
  );
}

const BOARD: Record<string, string> = {
  a: '♜', c: '♛', e: '♚', h: '♞', m: '♟', r: '♟',
  t: '♙', v: '♙', B: '♘', E: '♔', G: '♖',
};

/** Compact chess board corner with an animated knight move and a planning arrow. */
export function MiniChessBoard() {
  const cells = Array.from({ length: 36 }, (_, index) => index);
  const key = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
  return (
    <div className="lp-chess" aria-hidden="true">
      {cells.map(index => {
        const dark = (Math.floor(index / 6) + index) % 2 === 1;
        const piece = BOARD[key[index]];
        return (
          <span key={index} className={dark ? 'is-dark' : undefined}>
            {piece && <b className={piece.charCodeAt(0) >= 9818 ? 'is-black' : 'is-white'}>{piece}</b>}
          </span>
        );
      })}
      <b className="lp-chess-victim">♟</b>
      <b className="lp-chess-mover">♘</b>
      <svg className="lp-chess-arrow" viewBox="0 0 60 60" preserveAspectRatio="none">
        <path d="M15 42 L15 25 L21 25" />
      </svg>
    </div>
  );
}

const STROKES = [
  'M20 120 C 40 50, 90 45, 110 95 S 160 150, 180 80',
  'M112 136 h66 v42 h-66 Z',
  'M53 45 a22 22 0 1 1 44 0 a22 22 0 1 1 -44 0',
  'M24 184 l18 -18 l18 18 l18 -18 l18 18',
] as const;

/** Each participant draws their own strokes: [stroke index, start ms, end ms]. */
const DRAWERS = [
  { peer: PEERS[1], home: [20, 120], segments: [[0, 300, 2600], [2, 3300, 5000]] },
  { peer: PEERS[2], home: [112, 136], segments: [[1, 1000, 3200], [3, 3900, 5600]] },
] as const;
const LOOP_MS = 8800;
const FADE_MS = 7600;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const ease = (value: number) => value * value * (3 - 2 * value);

function SvgCursor({ peer, innerRef, home }: { peer: Peer; innerRef: (node: SVGGElement | null) => void; home: readonly number[] }) {
  return (
    <g ref={innerRef} transform={`translate(${home[0]} ${home[1]})`}>
      <path d="M0 0 L0 13 L3.6 9.6 L6.4 15.6 L8.6 14.6 L5.8 8.8 L10.6 8.6 Z" fill={peer.color} stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
      <rect x="10" y="14" width={peer.name.length * 5.4 + 9} height="12" rx="4" fill={peer.color} />
      <text x="14.5" y="23" fontSize="8.5" fontWeight="700" fill="#0b0b12">{peer.name}</text>
    </g>
  );
}

/** Whiteboard where each participant's cursor draws its own strokes in real time. */
export function WhiteboardSketch() {
  const ref = useRef<HTMLDivElement>(null);
  const paths = useRef<(SVGPathElement | null)[]>([]);
  const cursors = useRef<(SVGGElement | null)[]>([]);
  const active = useInView(ref);
  const reduced = useReducedMotion();

  useEffect(() => {
    const lengths = paths.current.map(path => path?.getTotalLength?.() ?? 0);
    const point = (stroke: number, progress: number) => {
      const path = paths.current[stroke];
      if (!path?.getPointAtLength) return { x: 0, y: 0 };
      return path.getPointAtLength(lengths[stroke] * progress);
    };
    const render = (time: number) => {
      const fade = time > FADE_MS ? clamp01((time - FADE_MS) / (LOOP_MS - FADE_MS)) : 0;
      DRAWERS.forEach((drawer, drawerIndex) => {
        let position = point(drawer.segments[0][0], 0);
        drawer.segments.forEach(([stroke, start, end], segment) => {
          const progress = clamp01((time - start) / (end - start));
          const path = paths.current[stroke];
          if (path) {
            path.style.strokeDasharray = `${lengths[stroke]}`;
            path.style.strokeDashoffset = `${lengths[stroke] * (1 - progress)}`;
            path.style.opacity = `${1 - fade}`;
            path.style.fillOpacity = `${progress}`;
          }
          if (time >= start) position = point(stroke, progress);
          const next = drawer.segments[segment + 1];
          if (next && time > end && time < next[1]) {
            const from = point(stroke, 1);
            const to = point(next[0], 0);
            const travel = ease((time - end) / (next[1] - end));
            position = { x: from.x + (to.x - from.x) * travel, y: from.y + (to.y - from.y) * travel };
          }
        });
        if (fade > 0) {
          const last = drawer.segments[drawer.segments.length - 1];
          const from = point(last[0], 1);
          const to = point(drawer.segments[0][0], 0);
          const travel = ease(fade);
          position = { x: from.x + (to.x - from.x) * travel, y: from.y + (to.y - from.y) * travel };
        }
        cursors.current[drawerIndex]?.setAttribute('transform', `translate(${position.x.toFixed(1)} ${position.y.toFixed(1)})`);
      });
    };
    if (reduced || !active || typeof requestAnimationFrame === 'undefined') {
      render(FADE_MS - 1);
      return;
    }
    let frame = 0;
    const origin = performance.now();
    const tick = (now: number) => {
      render((now - origin) % LOOP_MS);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, reduced]);

  return (
    <div ref={ref} className="lp-board" aria-hidden="true">
      <svg viewBox="0 0 200 200">
        {STROKES.map((d, index) => {
          const drawer = DRAWERS.find(item => item.segments.some(segment => segment[0] === index))!;
          return (
            <path
              key={d}
              ref={node => { paths.current[index] = node; }}
              className="lp-ink"
              d={d}
              stroke={drawer.peer.color}
              fill={index === 1 || index === 2 ? `${drawer.peer.color}22` : 'none'}
            />
          );
        })}
        {DRAWERS.map((drawer, index) => (
          <SvgCursor key={drawer.peer.name} peer={drawer.peer} home={drawer.home} innerRef={node => { cursors.current[index] = node; }} />
        ))}
      </svg>
    </div>
  );
}
