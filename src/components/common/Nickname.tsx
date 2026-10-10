import type { CSSProperties } from 'react';
import { useStore } from '../../hooks/useStore';
import { NICKNAME_FONTS, normalizeNicknameStyle, type NicknameStyle } from '../../core/nickname_style';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const palette = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#38bdf8', '#a78bfa', '#f472b6'];

/** Shared visual identity; names stay plain text in messages, labels and storage. */
export function Nickname({ name, peerId, isLocal = false, appearance, className = '' }: {
  name: string; peerId?: string; isLocal?: boolean; appearance?: NicknameStyle; className?: string;
}) {
  const saved = useStore(s => isLocal ? s.nicknameStyle : peerId ? s.peerNicknameStyles?.[peerId] : undefined);
  const style = normalizeNicknameStyle(appearance ?? saved);
  const variables = { '--nickname-color': style.color, '--nickname-secondary': style.secondaryColor,
    fontFamily: NICKNAME_FONTS[style.font] } as CSSProperties;
  const letters = style.effect === 'letters' || style.animation === 'wave';
  return <span className={`nickname ${className}`} style={variables} role={letters ? 'img' : undefined} aria-label={letters ? name : undefined}>
    <span className={`nickname-motion nickname-animation-${style.animation}`}>
      <span className={`nickname-ink nickname-effect-${style.effect}`}>
        {letters ? [...segmenter.segment(name.slice(0, 80))].map(({ segment }, index) =>
          <span key={index} aria-hidden="true" className="nickname-letter" style={{
            '--nickname-index': index, color: style.effect === 'letters' ? palette[index % palette.length] : undefined,
          } as CSSProperties}>{segment}</span>) : name}
      </span>
    </span>
  </span>;
}
