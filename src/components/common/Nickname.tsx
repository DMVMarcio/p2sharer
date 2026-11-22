import type { CSSProperties } from 'react';
import { useStore } from '../../hooks/useStore';
import { NICKNAME_FONTS, normalizeNicknameStyle, type NicknameStyle } from '../../core/nickname_style';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const palette = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#38bdf8', '#a78bfa', '#f472b6'];
const registeredHonkPalettes = new Set<string>();

function mixHex(a: string, b: string, weight: number): string {
  const parse = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const channel = (x: number, y: number) =>
    Math.round(x + (y - x) * weight).toString(16).padStart(2, '0');
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}

function solidHonkStops(color: string): string[] {
  return [
    mixHex(color, '#ffffff', 0.35),
    mixHex(color, '#ffffff', 0.18),
    color,
    mixHex(color, '#000000', 0.15),
    mixHex(color, '#000000', 0.28),
    mixHex(color, '#000000', 0.35),
  ];
}

function ensureHonkPalette(style: NicknameStyle, overrideColor?: string): string | undefined {
  if (style.font !== 'honk' || style.effect === 'none') return undefined;
  let stops: string[];
  if (overrideColor) {
    stops = solidHonkStops(overrideColor);
  } else if (style.effect === 'gradient') {
    stops = [
      style.color,
      mixHex(style.color, style.secondaryColor, 0.2),
      mixHex(style.color, style.secondaryColor, 0.45),
      mixHex(style.color, style.secondaryColor, 0.7),
      style.secondaryColor,
      mixHex(style.secondaryColor, '#000000', 0.2),
    ];
  } else if (style.effect === 'rainbow') {
    stops = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#38bdf8', '#a78bfa'];
  } else {
    stops = solidHonkStops(style.color);
  }
  const name = `--honk-${stops.map(hex => hex.slice(1)).join('-')}`;
  if (typeof document !== 'undefined' && !registeredHonkPalettes.has(name)) {
    registeredHonkPalettes.add(name);
    let sheet = document.querySelector<HTMLStyleElement>('style[data-honk-palettes]');
    if (!sheet) {
      sheet = document.createElement('style');
      sheet.setAttribute('data-honk-palettes', '');
      document.head.appendChild(sheet);
    }
    sheet.appendChild(document.createTextNode(
      `@font-palette-values ${name}{font-family:"Honk";base-palette:0;override-colors:${stops.map((c, i) => `${i + 2} ${c}`).join(',')};}`,
    ));
  }
  return name;
}

/** Shared visual identity; names stay plain text in messages, labels and storage. */
export function Nickname({ name, peerId, isLocal = false, appearance, className = '', defaultColor }: {
  name: string; peerId?: string; isLocal?: boolean; appearance?: NicknameStyle; className?: string; defaultColor?: string;
}) {
  const saved = useStore(s => isLocal ? s.nicknameStyle : peerId ? s.peerNicknameStyles?.[peerId] : undefined);
  const style = normalizeNicknameStyle(appearance ?? saved);
  const honkPalette = ensureHonkPalette(style);
  const variables = { '--nickname-color': style.color, '--nickname-secondary': style.secondaryColor, '--nickname-shine': style.shineColor,
    color: style.effect === 'none' ? defaultColor : undefined,
    fontFamily: NICKNAME_FONTS[style.font],
    fontPalette: honkPalette } as CSSProperties;
  const letters = style.effect === 'letters' || style.animation === 'wave';
  const graphemes = letters ? [...segmenter.segment(name.slice(0, 80))] : [];
  const count = Math.max(1, graphemes.length);
  const honkShine = style.font === 'honk' && style.effect === 'shine';
  return <span className={`nickname ${className}`} data-font={style.font} style={{ ...variables, '--nickname-count': count } as CSSProperties}
    role={letters ? 'img' : undefined} aria-label={letters ? name : undefined}>
    <span className={`nickname-motion nickname-animation-${style.animation}`}>
      <span className={letters ? 'nickname-letters' : `nickname-ink nickname-effect-${style.effect}`}
        data-text={!letters && honkShine ? name : undefined}>
        {letters ? graphemes.map(({ segment }, index) => {
          const letterColor = style.effect === 'letters' ? palette[index % palette.length] : undefined;
          const letterPalette = letterColor ? ensureHonkPalette(style, letterColor) : honkPalette;
          return <span key={index} aria-hidden="true" className="nickname-letter" style={{
            '--nickname-index': index,
            '--nickname-grad-pos': count > 1 ? `${(index / (count - 1)) * 100}%` : '0%',
            '--nickname-shine-start': `${((2 * count + index) / (3 * count - 1)) * 100}%`,
            '--nickname-shine-end': `${(index / (3 * count - 1)) * 100}%`,
            '--nickname-rainbow-start': `${(index / (2 * count - 1)) * 100}%`,
            '--nickname-rainbow-end': `${((2 * count + index) / (2 * count - 1)) * 100}%`,
            color: letterColor,
            fontPalette: letterPalette,
          } as CSSProperties}><span className={`nickname-ink nickname-effect-${style.effect}`}
            data-text={honkShine ? segment : undefined}>{segment}</span></span>;
        }) : name}
      </span>
    </span>
  </span>;
}
