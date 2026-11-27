import { useEffect, useRef } from 'react';
import { useReducedMotion } from '../../../src/core/appearance/appearance_preferences';
import { useInView } from './motion';
import { LiveCursor, PEERS, type Peer } from './scenes';

/*
 * Decorative screen contents shown inside the landing page's shared-screen
 * illustrations. Each scene uses the same 320 × 180 canvas so the overlays
 * drawn by its host (annotation ellipse, live pointer, remote shots) line up:
 * the focal point sits around (160, 132) and the top-right / bottom-left
 * corners stay free for the host's chips.
 */

const VIEW_BOX = '0 0 320 180';

/** Deterministic pseudo-random generator so the artwork is stable between renders. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

const MARKER_PATH = 'M194 117 C186 103 133 103 122 121 C112 139 146 152 172 148 C197 144 207 127 186 112';
const MARKER_REST = { x: 252, y: 46 };
const MARKER_LIFT = { x: 214, y: 100 };
const DRAW_LOOP_MS = 6200;

const smooth = (value: number) => value * value * (3 - 2 * value);
const mix = (from: { x: number; y: number }, to: { x: number; y: number }, amount: number) => ({
  x: from.x + (to.x - from.x) * amount,
  y: from.y + (to.y - from.y) * amount,
});

/**
 * A participant's pointer that draws a marker loop around the scene's focal
 * point: the ink follows the pointer tip, holds, then fades as the pointer
 * moves away. Coordinates share the scenes' 320 × 180 canvas.
 */
export function DrawingPointer({ peer }: { peer: Peer }) {
  const ref = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const pointerRef = useRef<HTMLDivElement>(null);
  const active = useInView(ref);
  const reduced = useReducedMotion();

  useEffect(() => {
    const path = pathRef.current;
    const pointer = pointerRef.current;
    if (!path || !pointer || !path.getTotalLength) return;
    const total = path.getTotalLength();
    const at = (progress: number) => path.getPointAtLength(total * progress);
    const render = (time: number) => {
      const phase = time / DRAW_LOOP_MS;
      let ink = 1;
      let opacity = 1;
      let position: { x: number; y: number };
      if (phase < 0.16) {
        ink = 0;
        position = mix(MARKER_REST, at(0), smooth(phase / 0.16));
      } else if (phase < 0.52) {
        ink = smooth((phase - 0.16) / 0.36);
        position = at(ink);
      } else if (phase < 0.78) {
        position = mix(at(1), MARKER_LIFT, smooth((phase - 0.52) / 0.26));
      } else {
        const leave = (phase - 0.78) / 0.22;
        opacity = 1 - smooth(Math.min(1, leave * 1.6));
        position = mix(MARKER_LIFT, MARKER_REST, smooth(leave));
      }
      path.style.strokeDashoffset = `${100 * (1 - ink)}`;
      path.style.opacity = `${opacity}`;
      pointer.style.left = `${(position.x / 320) * 100}%`;
      pointer.style.top = `${(position.y / 180) * 100}%`;
    };
    if (reduced || !active || typeof requestAnimationFrame === 'undefined') {
      render(DRAW_LOOP_MS * 0.6);
      return;
    }
    let frame = 0;
    const origin = performance.now();
    const tick = (now: number) => {
      render((now - origin) % DRAW_LOOP_MS);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, reduced]);

  return (
    <div ref={ref} className="lp-draw-layer" aria-hidden="true">
      <svg className="lp-annotation" viewBox={VIEW_BOX} preserveAspectRatio="xMidYMid slice">
        <path ref={pathRef} pathLength={100} d={MARKER_PATH} />
      </svg>
      <div ref={pointerRef} className="lp-draw-pointer">
        <LiveCursor peer={peer} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Neon racer                                                                 */
/* -------------------------------------------------------------------------- */

const HORIZON = 88;
const SUN_BANDS = [[63, 1.4], [70, 2], [77, 2.6], [83, 3.2]] as const;
const GRID_FAN = [-6, -5, -4, -3, -2, 2, 3, 4, 5, 6];
const ROAD_DASHES = [0, -0.4, -0.8];
const GRID_LINES = [0, -0.32, -0.64, -0.96, -1.28];
const ROAD_POSTS = [0, -0.6];
const STREAKS = [
  { dx: -62, dy: 26, delay: 0 },
  { dx: 66, dy: 30, delay: -0.3 },
  { dx: -96, dy: 52, delay: -0.55 },
  { dx: 92, dy: 50, delay: -0.15 },
];

/** Synthwave racing game: a rear-view sports car chasing a rival into the sunset. */
export function RacingScene() {
  return (
    <svg className="lp-game-scene lp-race" viewBox={VIEW_BOX} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="lp-race-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0b0620" />
          <stop offset="0.62" stopColor="#3b0f5c" />
          <stop offset="1" stopColor="#ff4f9a" />
        </linearGradient>
        <linearGradient id="lp-race-sun" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff3a3" />
          <stop offset="0.5" stopColor="#ff8a3d" />
          <stop offset="1" stopColor="#ff2d8a" />
        </linearGradient>
        <linearGradient id="lp-race-ground" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1d0a33" />
          <stop offset="1" stopColor="#07020f" />
        </linearGradient>
        <linearGradient id="lp-race-road" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b1250" />
          <stop offset="1" stopColor="#140726" />
        </linearGradient>
        <linearGradient id="lp-race-paint" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f0abfc" />
          <stop offset="0.5" stopColor="#c026d3" />
          <stop offset="1" stopColor="#581c87" />
        </linearGradient>
        <mask id="lp-race-sun-mask">
          <rect x="110" y="30" width="100" height="70" fill="#fff" />
          {SUN_BANDS.map(([y, height]) => <rect key={y} x="110" y={y} width="100" height={height} fill="#000" />)}
        </mask>
        <clipPath id="lp-race-ground-clip">
          <rect y={HORIZON} width="320" height={180 - HORIZON} />
        </clipPath>
      </defs>

      <rect width="320" height={HORIZON + 1} fill="url(#lp-race-sky)" />
      <g fill="#fff">
        <circle className="lp-twinkle" cx="34" cy="18" r="1.1" />
        <circle cx="76" cy="36" r="0.8" />
        <circle className="lp-twinkle" cx="118" cy="14" r="0.9" />
        <circle cx="206" cy="22" r="1" />
        <circle className="lp-twinkle" cx="248" cy="42" r="0.8" />
        <circle cx="296" cy="16" r="1.2" />
      </g>
      <circle cx="160" cy="70" r="34" fill="url(#lp-race-sun)" mask="url(#lp-race-sun-mask)" />
      <g fill="#5b1a7a" stroke="#ff6ec7" strokeOpacity="0.55" strokeWidth="0.6" strokeLinejoin="round">
        <path d="M0 88 L22 73 L40 80 L64 60 L88 77 L104 69 L126 88 Z" />
        <path d="M196 88 L218 71 L238 79 L262 58 L286 75 L304 65 L320 72 L320 88 Z" />
      </g>
      <g fill="#2a0b45">
        <path d="M0 88 L30 79 L52 85 L76 75 L104 88 Z" />
        <path d="M222 88 L250 77 L272 83 L298 73 L320 81 L320 88 Z" />
      </g>
      <rect y={HORIZON} width="320" height={180 - HORIZON} fill="url(#lp-race-ground)" />

      <g clipPath="url(#lp-race-ground-clip)">
        <g stroke="#ff4f9a" strokeOpacity="0.4" strokeWidth="0.8">
          {GRID_FAN.map(step => <line key={step} x1="160" y1={HORIZON} x2={160 + step * 90} y2="180" />)}
          {GRID_LINES.map(delay => (
            <line key={delay} className="lp-race-zoom is-slow" x1="-900" x2="1220" y1="176" y2="176" style={{ animationDelay: `${delay}s` }} />
          ))}
        </g>
        <polygon points={`157,${HORIZON} 163,${HORIZON} 272,180 48,180`} fill="url(#lp-race-road)" />
        <g stroke="#22d3ee" strokeLinecap="round">
          <path d={`M157 ${HORIZON} L48 180 M163 ${HORIZON} L272 180`} strokeWidth="4" strokeOpacity="0.22" />
          <path d={`M157 ${HORIZON} L48 180 M163 ${HORIZON} L272 180`} strokeWidth="1.2" />
        </g>
        {ROAD_DASHES.map(delay => (
          <polygon key={delay} className="lp-race-zoom" points="158.6,140 161.4,140 162.6,166 157.4,166" fill="#fde68a" style={{ animationDelay: `${delay}s` }} />
        ))}
        {ROAD_POSTS.map(delay => (
          <g key={delay} className="lp-race-zoom" style={{ animationDelay: `${delay}s` }}>
            <rect x="51" y="154" width="3" height="16" rx="1" fill="#22d3ee" />
            <rect x="266" y="154" width="3" height="16" rx="1" fill="#22d3ee" />
            <circle cx="52.5" cy="154" r="2.4" fill="#ecfeff" />
            <circle cx="267.5" cy="154" r="2.4" fill="#ecfeff" />
          </g>
        ))}
        <g stroke="#fff" strokeOpacity="0.7" strokeWidth="0.9" strokeLinecap="round">
          {STREAKS.map(({ dx, dy, delay }) => (
            <line
              key={dx}
              className="lp-race-zoom is-fast"
              x1={160 + dx} y1={HORIZON + dy}
              x2={160 + dx * 1.18} y2={HORIZON + dy * 1.18}
              style={{ animationDelay: `${delay}s` }}
            />
          ))}
        </g>
      </g>

      <g transform="translate(176 104)">
        <g className="lp-race-rival">
          <ellipse cx="0" cy="4.5" rx="11" ry="1.4" fill="#000" opacity="0.5" />
          <rect x="-9" y="1" width="4" height="3.4" rx="1" fill="#05030a" />
          <rect x="5" y="1" width="4" height="3.4" rx="1" fill="#05030a" />
          <rect x="-6" y="-9.5" width="12" height="4.5" rx="1.6" fill="#082f49" />
          <rect x="-9.5" y="-6" width="19" height="7.5" rx="2" fill="#0ea5e9" />
          <rect x="-8.5" y="-3.4" width="5" height="1.6" rx="0.8" fill="#ff2d55" />
          <rect x="3.5" y="-3.4" width="5" height="1.6" rx="0.8" fill="#ff2d55" />
        </g>
      </g>

      <g transform="translate(160 0)">
        <g className="lp-race-car">
          <ellipse cx="0" cy="153" rx="42" ry="4.5" fill="#000" opacity="0.55" />
          <rect x="-36" y="136" width="12" height="16" rx="2.5" fill="#0a0612" />
          <rect x="24" y="136" width="12" height="16" rx="2.5" fill="#0a0612" />
          <path d="M-20 119 L-15 108 Q-13 105 -9 105 L9 105 Q13 105 15 108 L20 119 Z" fill="#2e1065" />
          <path d="M-14.5 117 L-10.5 109 L10.5 109 L14.5 117 Z" fill="#22d3ee" opacity="0.55" />
          <path d="M-8 110 L-11 116" stroke="#ecfeff" strokeOpacity="0.7" strokeWidth="1.2" strokeLinecap="round" />
          <path d="M-34 148 L-33 132 Q-31 122 -20 119 L20 119 Q31 122 33 132 L34 148 Q34 151 31 151 L-31 151 Q-34 151 -34 148 Z" fill="url(#lp-race-paint)" />
          <rect x="-24" y="123" width="3" height="5" fill="#1e0b36" />
          <rect x="21" y="123" width="3" height="5" fill="#1e0b36" />
          <rect x="-38" y="119.5" width="76" height="3.5" rx="1.5" fill="#1e0b36" />
          <rect x="-31" y="129.5" width="62" height="9" rx="4" fill="#ff2d75" opacity="0.28" />
          <rect x="-30" y="132" width="21" height="4" rx="2" fill="#ff2d75" />
          <rect x="9" y="132" width="21" height="4" rx="2" fill="#ff2d75" />
          <rect x="-8" y="133" width="16" height="2" rx="1" fill="#ffb3cf" />
          <rect x="-8" y="140.5" width="16" height="6" rx="1" fill="#fdf4ff" />
          <rect x="-5" y="142.8" width="10" height="1.4" rx="0.7" fill="#a21caf" />
          <rect x="-24" y="148" width="48" height="3" rx="1" fill="#12061f" />
          <circle className="lp-race-flame" cx="-15" cy="151" r="2.2" fill="#fb923c" />
          <circle className="lp-race-flame" cx="15" cy="151" r="2.2" fill="#fb923c" />
        </g>
      </g>

      <g className="lp-game-hud">
        <rect x="8" y="8" width="64" height="24" rx="5" fill="#0b0620" opacity="0.62" stroke="#ff4f9a" strokeOpacity="0.5" strokeWidth="0.6" />
        <path d="M14 13 V27 M14 13 H22 L20.2 15.5 L22 18 H14" fill="#f9a8d4" stroke="#f9a8d4" strokeWidth="1" strokeLinejoin="round" />
        <text x="25" y="23.5" fontSize="9" fontWeight="800" fill="#fff">2/3</text>
        <line x1="43" y1="12" x2="43" y2="28" stroke="#ff4f9a" strokeOpacity="0.45" strokeWidth="0.6" />
        <text x="48" y="23.5" fontSize="9" fontWeight="800" fill="#fde68a">#1</text>
      </g>
      <g transform="translate(292 156)">
        <circle r="18" fill="#0b0620" opacity="0.66" stroke="#22d3ee" strokeOpacity="0.45" strokeWidth="0.7" />
        <path d="M-12.1 7 A14 14 0 1 1 12.1 7" fill="none" stroke="#22d3ee" strokeOpacity="0.35" strokeWidth="2" strokeLinecap="round" />
        <path d="M6 -12.6 A14 14 0 0 1 12.1 7" fill="none" stroke="#ff4f9a" strokeWidth="2" strokeLinecap="round" />
        <line className="lp-race-needle" x1="0" y1="0" x2="0" y2="-12" stroke="#fde68a" strokeWidth="1.4" strokeLinecap="round" />
        <circle r="1.8" fill="#fde68a" />
        <text y="10.5" textAnchor="middle" fontSize="6.5" fontWeight="800" fill="#fff">238</text>
      </g>
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Music studio                                                               */
/* -------------------------------------------------------------------------- */

const TRACK_TOP = 28;
const TRACK_HEIGHT = 24;
const LANE_X = 60;

type ClipContent = 'hits' | 'wave' | 'notes';
const TRACKS: { color: string; content: ClipContent; clips: [number, number][] }[] = [
  { color: '#f472b6', content: 'hits', clips: [[62, 62], [128, 62], [194, 62], [260, 58]] },
  { color: '#38bdf8', content: 'wave', clips: [[62, 124], [194, 124]] },
  { color: '#fbbf24', content: 'notes', clips: [[62, 96], [194, 126]] },
  { color: '#a78bfa', content: 'wave', clips: [[96, 128], [260, 58]] },
  { color: '#34d399', content: 'wave', clips: [[62, 52], [124, 72], [228, 60]] },
];
const SELECTED_CLIP = { track: 4, clip: 1 };

function waveformPath(x: number, width: number, mid: number, amplitude: number, seed: number) {
  const random = seeded(seed);
  let path = '';
  for (let offset = 2; offset < width - 1.5; offset += 2) {
    const envelope = Math.sin((Math.PI * offset) / width) ** 0.6;
    const height = Math.max(0.4, amplitude * envelope * (0.3 + 0.7 * random()));
    path += `M${(x + offset).toFixed(1)} ${(mid - height).toFixed(1)}V${(mid + height).toFixed(1)}`;
  }
  return path;
}

function clipContent(content: ClipContent, x: number, width: number, top: number, seed: number) {
  const mid = top + 13;
  if (content === 'wave') return <path d={waveformPath(x, width, mid, 6, seed)} />;
  const random = seeded(seed);
  if (content === 'hits') {
    return Array.from({ length: Math.floor((width - 4) / 8) }, (_, index) => {
      const tall = index % 2 === 0;
      return <rect key={index} x={x + 3 + index * 8} y={tall ? mid - 6 : mid - 2} width="2" height={tall ? 12 : 6} rx="1" />;
    });
  }
  return Array.from({ length: Math.floor((width - 6) / 10) }, (_, index) => (
    <rect key={index} x={x + 3 + index * 10} y={top + 6 + Math.floor(random() * 5) * 3} width={6 + Math.floor(random() * 3) * 2} height="2.4" rx="1" />
  ));
}

const KNOBS = [{ x: 140, angle: -0.8 }, { x: 156, angle: 0.6 }, { x: 172, angle: 0 }];
const SPECTRUM = Array.from({ length: 17 }, (_, index) => {
  const random = seeded(index + 11);
  return { x: 190 + index * 6, height: 8 + 14 * Math.sin((Math.PI * (index + 2)) / 21) * (0.6 + 0.4 * random()), duration: 0.45 + random() * 0.5, delay: -random() };
});

/** Screen-shared music production app with a moving playhead and live spectrum. */
export function StudioScene() {
  const laneWidth = 320 - LANE_X;
  return (
    <svg className="lp-game-scene lp-studio" viewBox={VIEW_BOX} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="lp-studio-spectrum" x1="0" y1="176" x2="0" y2="154" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#34d399" />
          <stop offset="0.6" stopColor="#fde047" />
          <stop offset="1" stopColor="#f472b6" />
        </linearGradient>
      </defs>
      <rect width="320" height="180" fill="#0d0f16" />

      <rect width="320" height="20" fill="#151826" />
      <rect x="8" y="5" width="13" height="10" rx="3" fill="#22c55e" />
      <path d="M12.5 7.3 L17.3 10 L12.5 12.7 Z" fill="#0d0f16" />
      <circle className="lp-studio-rec" cx="29" cy="10" r="3.4" fill="#ef4444" />
      <text x="38" y="12.6" fontSize="7" fontWeight="700" fontFamily="ui-monospace, monospace" fill="#e2e8f0">02:14.6</text>
      <rect x="76" y="5" width="34" height="10" rx="3" fill="#1f2335" />
      <text x="93" y="12" textAnchor="middle" fontSize="5.4" fontWeight="700" fontFamily="ui-monospace, monospace" fill="#94a3b8">128 BPM</text>

      <rect x={LANE_X} y="20" width={laneWidth} height="7" fill="#111420" />
      <g stroke="#3b4157" strokeWidth="0.6">
        {Array.from({ length: 17 }, (_, index) => (
          <line key={index} x1={LANE_X + index * 16} x2={LANE_X + index * 16} y1={index % 4 === 0 ? 21 : 24} y2="27" />
        ))}
      </g>

      {TRACKS.map((track, trackIndex) => {
        const top = TRACK_TOP + trackIndex * TRACK_HEIGHT;
        return (
          <g key={track.color}>
            <rect x={LANE_X} y={top - 1} width={laneWidth} height={TRACK_HEIGHT} fill={trackIndex % 2 ? '#10131c' : '#12151f'} />
            <rect x="2" y={top} width="56" height="22" rx="3" fill="#171a28" />
            <rect x="2" y={top} width="3" height="22" rx="1.5" fill={track.color} />
            <rect x="9" y={top + 5} width={20 + (trackIndex % 3) * 6} height="3" rx="1.5" fill="#3b4157" />
            <rect x="9" y={top + 13} width="7" height="5" rx="1.2" fill={trackIndex === 3 ? '#f59e0b' : '#252a3d'} />
            <rect x="18" y={top + 13} width="7" height="5" rx="1.2" fill="#252a3d" />
            <rect x="30" y={top + 14} width="24" height="3" rx="1.5" fill="#252a3d" />
            <rect
              className="lp-studio-level"
              x="30" y={top + 14} width="24" height="3" rx="1.5"
              fill={track.color}
              style={{ animationDelay: `${-trackIndex * 0.23}s`, animationDuration: `${0.6 + trackIndex * 0.12}s` }}
            />
            {track.clips.map(([x, width], clipIndex) => {
              const selected = SELECTED_CLIP.track === trackIndex && SELECTED_CLIP.clip === clipIndex;
              return (
                <g key={x}>
                  {selected && <rect className="lp-studio-selected" x={x - 1.5} y={top - 1.5} width={width + 3} height="25" rx="4" fill="none" stroke="#fff" strokeWidth="0.9" />}
                  <rect x={x} y={top} width={width} height="22" rx="3" fill={track.color} fillOpacity={selected ? 0.34 : 0.2} stroke={track.color} strokeOpacity="0.75" strokeWidth="0.7" />
                  <rect x={x} y={top} width={width} height="4" rx="2" fill={track.color} fillOpacity="0.6" />
                  <g fill={track.color} stroke={track.color} strokeWidth="1" strokeLinecap="round" opacity="0.9">
                    {clipContent(track.content, x, width, top, trackIndex * 31 + clipIndex * 7 + 3)}
                  </g>
                </g>
              );
            })}
          </g>
        );
      })}

      <g className="lp-studio-playhead">
        <line x1={LANE_X} x2={LANE_X} y1="20" y2="148" stroke="#f8fafc" strokeWidth="0.8" />
        <path d={`M${LANE_X - 3} 20 H${LANE_X + 3} L${LANE_X} 24 Z`} fill="#f8fafc" />
      </g>

      <rect y="149" width="320" height="31" fill="#151826" />
      <g fill="#252a3d" stroke="#3b4157" strokeWidth="0.6">
        {KNOBS.map(knob => <circle key={knob.x} cx={knob.x} cy="164" r="6" />)}
      </g>
      <g stroke="#e2e8f0" strokeWidth="1.1" strokeLinecap="round">
        {KNOBS.map(knob => (
          <line key={knob.x} x1={knob.x} y1="164" x2={knob.x + 4.6 * Math.sin(knob.angle)} y2={164 - 4.6 * Math.cos(knob.angle)} />
        ))}
      </g>
      <g fill="url(#lp-studio-spectrum)">
        {SPECTRUM.map(bar => (
          <rect
            key={bar.x}
            className="lp-studio-bar"
            x={bar.x} y={176 - bar.height} width="4" height={bar.height} rx="1"
            style={{ animationDuration: `${bar.duration.toFixed(2)}s`, animationDelay: `${bar.delay.toFixed(2)}s` }}
          />
        ))}
      </g>
      <g fill="#252a3d">
        <rect x="300" y="153" width="4" height="23" rx="1.5" />
        <rect x="308" y="153" width="4" height="23" rx="1.5" />
      </g>
      <g fill="#34d399">
        <rect className="lp-studio-channel" x="300" y="153" width="4" height="23" rx="1.5" />
        <rect className="lp-studio-channel is-right" x="308" y="153" width="4" height="23" rx="1.5" />
      </g>
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Co-op space shooter                                                        */
/* -------------------------------------------------------------------------- */

const INVADER_ROWS = [
  { y: 36, color: '#f472b6', xs: [120, 140, 160, 180, 200] },
  { y: 54, color: '#fbbf24', xs: [130, 150, 170, 190] },
];
const ALIENS = INVADER_ROWS.flatMap(row => row.xs.map(x => ({ x, y: row.y, color: row.color })));
const alienAt = (x: number, y: number) => ALIENS.findIndex(alien => alien.x === x && alien.y === y);
const [PLAYER_ONE, PLAYER_TWO] = [PEERS[1], PEERS[2]];

/*
 * Scripted wave: each ship flies under its own targets and fires; an alien is
 * destroyed when the bullet reaches it and explodes in place. P1 clears the
 * right side while P2 clears the left, so the two players never share a
 * target. Once the wave is cleared the ships return home and the aliens drop
 * back into formation.
 */
const SLOT_MS = 950;
const FIRE_AT = 0.4;
const HIT_AT = 0.65;
const BOOM_MS = 520;
const RETURN_MS = 500;
const RESPAWN_AT = 6000;
const RESPAWN_STAGGER = 70;
const DROP_MS = 450;
const WAVE_MS = 7200;
const BASE_SCORE = 12450;

const SHIPS = [
  { peer: PLAYER_ONE, home: 214, noseY: 138, offset: 650, targets: [[200, 36], [190, 54], [180, 36], [170, 54], [160, 36]] },
  { peer: PLAYER_TWO, home: 112, noseY: 144, offset: 200, targets: [[150, 54], [140, 36], [130, 54], [120, 36]] },
].map(ship => ({ ...ship, targets: ship.targets.map(([x, y]) => alienAt(x, y)) }));

const HIT_TIMES = ALIENS.map(() => Infinity);
for (const ship of SHIPS) {
  ship.targets.forEach((alien, index) => { HIT_TIMES[alien] = ship.offset + (index + HIT_AT) * SLOT_MS; });
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function shipAt(ship: (typeof SHIPS)[number], time: number) {
  const end = ship.offset + ship.targets.length * SLOT_MS;
  if (time < ship.offset) return { x: ship.home, bullet: null };
  if (time >= end) {
    const last = ALIENS[ship.targets[ship.targets.length - 1]].x;
    return { x: last + (ship.home - last) * smooth(clamp01((time - end) / RETURN_MS)), bullet: null };
  }
  const slot = Math.floor((time - ship.offset) / SLOT_MS);
  const phase = (time - ship.offset) / SLOT_MS - slot;
  const target = ALIENS[ship.targets[slot]];
  const from = slot === 0 ? ship.home : ALIENS[ship.targets[slot - 1]].x;
  if (phase < FIRE_AT) return { x: from + (target.x - from) * smooth(phase / FIRE_AT), bullet: null };
  if (phase >= HIT_AT) return { x: target.x, bullet: null };
  const travel = (phase - FIRE_AT) / (HIT_AT - FIRE_AT);
  const startY = ship.noseY - 6;
  return { x: target.x, bullet: { x: target.x, y: startY + (target.y + 3 - startY) * travel } };
}

function starField(count: number, seed: number) {
  const random = seeded(seed);
  return Array.from({ length: count }, () => ({ x: random() * 320, y: random() * 180, r: 0.4 + random() * 0.8 }));
}

const FAR_STARS = starField(34, 5);
const NEAR_STARS = starField(14, 23);

function Stars({ stars, className }: { stars: { x: number; y: number; r: number }[]; className: string }) {
  return (
    <g className={className} fill="#fff">
      {[0, -180].map(offset => (
        <g key={offset} transform={`translate(0 ${offset})`}>
          {stars.map(star => <circle key={`${star.x}-${star.y}`} cx={star.x} cy={star.y} r={star.r} />)}
        </g>
      ))}
    </g>
  );
}

/**
 * Two-player co-op shooter, matching the remote-play demo's two gamepads. The
 * P1 ship's position is exposed to the host screen as `--p1-x` so the shots the
 * visitor fires from the demo buttons leave from that ship.
 */
export function ShooterScene() {
  const ref = useRef<SVGSVGElement>(null);
  const ships = useRef<(SVGGElement | null)[]>([]);
  const bullets = useRef<(SVGRectElement | null)[]>([]);
  const aliens = useRef<(SVGGElement | null)[]>([]);
  const booms = useRef<(SVGGElement | null)[]>([]);
  const score = useRef<SVGTextElement>(null);
  const active = useInView(ref);
  const reduced = useReducedMotion();

  useEffect(() => {
    const host = ref.current?.parentElement;
    const render = (elapsed: number) => {
      const time = elapsed % WAVE_MS;
      SHIPS.forEach((ship, index) => {
        const state = shipAt(ship, time);
        ships.current[index]?.setAttribute('transform', `translate(${state.x.toFixed(2)} ${ship.noseY})`);
        const bullet = bullets.current[index];
        if (bullet) {
          bullet.style.opacity = state.bullet ? '1' : '0';
          if (state.bullet) {
            bullet.setAttribute('x', (state.bullet.x - 1).toFixed(2));
            bullet.setAttribute('y', state.bullet.y.toFixed(2));
          }
        }
        if (index === 0) host?.style.setProperty('--p1-x', `${((state.x / 320) * 100).toFixed(2)}%`);
      });
      let kills = 0;
      ALIENS.forEach((_, index) => {
        const hit = HIT_TIMES[index];
        const respawn = RESPAWN_AT + index * RESPAWN_STAGGER;
        const alien = aliens.current[index];
        if (time >= hit && time < respawn) kills += 1;
        if (alien) {
          const drop = time >= respawn ? clamp01((time - respawn) / DROP_MS) : 1;
          const visible = time < hit || time >= respawn;
          alien.style.opacity = visible ? `${drop}` : '0';
          alien.setAttribute('transform', `translate(0 ${(-(1 - smooth(drop)) * 10).toFixed(2)})`);
        }
        const boom = booms.current[index];
        if (boom) {
          const progress = (time - hit) / BOOM_MS;
          const showing = progress >= 0 && progress < 1;
          boom.style.opacity = showing ? `${1 - progress}` : '0';
          if (showing) boom.setAttribute('transform', `translate(${ALIENS[index].x} ${ALIENS[index].y}) scale(${(0.3 + progress * 1.1).toFixed(3)})`);
        }
      });
      if (score.current) {
        const wave = Math.floor(elapsed / WAVE_MS);
        score.current.textContent = String(BASE_SCORE + (wave * ALIENS.length + kills) * 150).padStart(6, '0');
      }
    };
    if (reduced || !active || typeof requestAnimationFrame === 'undefined') {
      render(0);
      return;
    }
    let frame = 0;
    const origin = performance.now();
    const tick = (now: number) => {
      render(now - origin);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, reduced]);

  return (
    <svg ref={ref} className="lp-game-scene lp-duo" viewBox={VIEW_BOX} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="lp-duo-space" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#050816" />
          <stop offset="1" stopColor="#1b1145" />
        </linearGradient>
        <radialGradient id="lp-duo-nebula-a">
          <stop offset="0" stopColor="#c026d3" stopOpacity="0.5" />
          <stop offset="1" stopColor="#c026d3" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="lp-duo-nebula-b">
          <stop offset="0" stopColor="#0ea5e9" stopOpacity="0.4" />
          <stop offset="1" stopColor="#0ea5e9" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="lp-duo-planet" cx="0.35" cy="0.3">
          <stop offset="0" stopColor="#fdba74" />
          <stop offset="0.6" stopColor="#ea580c" />
          <stop offset="1" stopColor="#431407" />
        </radialGradient>
        <g id="lp-duo-ship">
          <path d="M0 0 L6 14 L16 20 L6 22 L0 19 L-6 22 L-16 20 L-6 14 Z" fill="currentColor" />
          <path d="M-6 14 L-16 20 L-6 22 Z M6 14 L16 20 L6 22 Z" fill="#000" opacity="0.25" />
          <ellipse cx="0" cy="12" rx="2.4" ry="4" fill="#e0f2fe" />
        </g>
        <g id="lp-duo-invader" shapeRendering="crispEdges">
          <rect x="-4" y="-5" width="2" height="2" fill="currentColor" />
          <rect x="2" y="-5" width="2" height="2" fill="currentColor" />
          <rect x="-5" y="-3" width="10" height="5" fill="currentColor" />
          <rect x="-3" y="-2" width="2" height="2" fill="#0b0820" />
          <rect x="1" y="-2" width="2" height="2" fill="#0b0820" />
          <rect x="-6" y="0" width="2" height="4" fill="currentColor" />
          <rect x="4" y="0" width="2" height="4" fill="currentColor" />
          <rect x="-2" y="2" width="4" height="1.5" fill="currentColor" />
        </g>
        <g id="lp-duo-boom">
          <circle r="10" fill="#fde047" opacity="0.35" />
          <circle r="5" fill="#fff7ed" />
          <g stroke="#fb923c" strokeWidth="1.4" strokeLinecap="round">
            <path d="M0 -8 V-13 M0 8 V13 M-8 0 H-13 M8 0 H13 M5.5 5.5 L9 9 M-5.5 -5.5 L-9 -9 M5.5 -5.5 L9 -9 M-5.5 5.5 L-9 9" />
          </g>
        </g>
      </defs>

      <rect width="320" height="180" fill="url(#lp-duo-space)" />
      <ellipse cx="80" cy="70" rx="110" ry="60" fill="url(#lp-duo-nebula-a)" />
      <ellipse cx="250" cy="40" rx="90" ry="50" fill="url(#lp-duo-nebula-b)" />
      <Stars stars={FAR_STARS} className="lp-duo-stars" />
      <g opacity="0.9">
        <g transform="rotate(-14 286 134)" fill="none" stroke="#fed7aa" strokeWidth="2">
          <ellipse cx="286" cy="134" rx="44" ry="7" strokeOpacity="0.3" />
        </g>
        <circle cx="286" cy="134" r="24" fill="url(#lp-duo-planet)" />
        <g transform="rotate(-14 286 134)" fill="none" stroke="#fed7aa" strokeWidth="2">
          <path d="M242 134 A44 7 0 0 0 330 134" strokeOpacity="0.6" />
        </g>
      </g>
      <Stars stars={NEAR_STARS} className="lp-duo-stars is-near" />

      <g transform="translate(56 96)">
        <polygon className="lp-duo-rock" points="-9,-4 -4,-10 5,-9 10,-2 7,7 -2,10 -9,5" fill="#57534e" stroke="#a8a29e" strokeWidth="0.8" />
      </g>

      {ALIENS.map((alien, index) => (
        <g key={`${alien.x}-${alien.y}`} ref={node => { aliens.current[index] = node; }}>
          <g transform={`translate(${alien.x} ${alien.y}) scale(1.4)`}>
            <g className="lp-duo-bob" style={{ animationDelay: `${-(index % 2) * 0.4}s` }}>
              <use href="#lp-duo-invader" color={alien.color} />
            </g>
          </g>
        </g>
      ))}
      {ALIENS.map((alien, index) => (
        <g key={`boom-${alien.x}-${alien.y}`} ref={node => { booms.current[index] = node; }} style={{ opacity: 0 }}>
          <use href="#lp-duo-boom" />
        </g>
      ))}

      {SHIPS.map((ship, index) => (
        <rect
          key={`bullet-${ship.peer.name}`}
          ref={node => { bullets.current[index] = node; }}
          width="2" height="6" rx="1"
          fill={ship.peer.color}
          style={{ opacity: 0, filter: `drop-shadow(0 0 2px ${ship.peer.color})` }}
        />
      ))}
      {SHIPS.map((ship, index) => (
        <g key={ship.peer.name} ref={node => { ships.current[index] = node; }} transform={`translate(${ship.home} ${ship.noseY})`}>
          <g className="lp-duo-hover" style={{ animationDelay: `${-index * 0.8}s` }}>
            <path className="lp-duo-flame" d="M-3.4 19 L0 30 L3.4 19 Z" fill="#fb923c" />
            <path className="lp-duo-flame" d="M-1.6 19 L0 25 L1.6 19 Z" fill="#fef3c7" />
            <use href="#lp-duo-ship" color={ship.peer.color} />
          </g>
        </g>
      ))}

      <g className="lp-game-hud">
        <rect x="8" y="8" width="76" height="24" rx="5" fill="#050816" opacity="0.6" stroke="#38bdf8" strokeOpacity="0.4" strokeWidth="0.6" />
        <path d="M17 12 L18.8 16 L23 16.4 L19.8 19.2 L20.8 23.4 L17 21.2 L13.2 23.4 L14.2 19.2 L11 16.4 L15.2 16 Z" fill="#fde047" />
        <text ref={score} x="27" y="20.5" fontSize="8" fontWeight="800" fontFamily="ui-monospace, monospace" fill="#fff">{String(BASE_SCORE).padStart(6, '0')}</text>
        <g transform="translate(16 25.5) scale(0.22)"><use href="#lp-duo-ship" color={PLAYER_ONE.color} /></g>
        <g transform="translate(24 25.5) scale(0.22)"><use href="#lp-duo-ship" color={PLAYER_ONE.color} /></g>
        <g transform="translate(36 25.5) scale(0.22)"><use href="#lp-duo-ship" color={PLAYER_TWO.color} /></g>
        <g transform="translate(44 25.5) scale(0.22)"><use href="#lp-duo-ship" color={PLAYER_TWO.color} /></g>
        <g transform="translate(52 25.5) scale(0.22)"><use href="#lp-duo-ship" color={PLAYER_TWO.color} /></g>
      </g>
    </svg>
  );
}
