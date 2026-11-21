import type { CSSProperties } from 'react';

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

/** Whiteboard sketch drawn live by participants. */
export function WhiteboardSketch() {
  return (
    <div className="lp-board" aria-hidden="true">
      <svg viewBox="0 0 240 150">
        <path className="lp-ink lp-ink-1" d="M24 98 C 40 40, 82 34, 104 72 S 150 120, 176 64" />
        <rect className="lp-ink lp-ink-2" x="138" y="86" width="72" height="44" rx="10" />
        <circle className="lp-ink lp-ink-3" cx="58" cy="44" r="18" />
        <path className="lp-ink lp-ink-4" d="M110 122 L130 104 L150 122" />
      </svg>
      <LiveCursor peer={PEERS[1]} className="lp-board-cursor-a" />
      <LiveCursor peer={PEERS[2]} className="lp-board-cursor-b" />
    </div>
  );
}
