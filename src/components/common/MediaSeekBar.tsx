import React, { useRef, useState } from 'react';
import { formatMediaTime } from '../../core/media_time';

interface Props {
  value: number;
  duration: number;
  buffered?: number;
  onCommit: (seconds: number) => void;
  disabled?: boolean;
}

export const MediaSeekBar: React.FC<Props> = ({ value, duration, buffered = 0, onCommit,
  disabled = false }) => {
  const [draft, setDraft] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const draftRef = useRef<number | null>(null);
  const maximum = Math.max(1, Math.floor(duration));
  const shown = Math.min(maximum, Math.max(0, draft ?? value));
  const progress = shown / maximum * 100;
  const tooltipTime = draft ?? hover;
  const tooltipPosition = Math.max(5, Math.min(95, (tooltipTime ?? 0) / maximum * 100));

  const setPending = (seconds: number) => {
    draftRef.current = seconds;
    setDraft(seconds);
  };
  const commit = (pending = draftRef.current) => {
    if (pending === null) return;
    draftRef.current = null;
    setDraft(null);
    onCommit(Math.min(maximum, Math.max(0, pending)));
  };
  const trackPointer = (event: React.PointerEvent<HTMLInputElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHover(ratio * maximum);
  };

  return <div className="media-seek" style={{
    '--media-progress': `${progress}%`,
    '--media-buffered': `${Math.max(progress, Math.min(100, buffered * 100))}%`,
    '--media-tooltip-position': `${tooltipPosition}%`,
  } as React.CSSProperties}>
    <input autoComplete="off" type="range" min="0" max={maximum} step="1" value={shown} disabled={disabled}
      aria-label="Posição do vídeo" aria-valuetext={`${formatMediaTime(shown)} de ${formatMediaTime(duration)}`}
      onChange={(event) => setPending(Number(event.target.value))}
      onPointerMove={trackPointer} onPointerLeave={() => setHover(null)}
      onPointerUp={(event) => commit(Number(event.currentTarget.value))}
      onPointerCancel={() => commit()}
      onKeyUp={() => commit()} onBlur={() => commit()} />
    {tooltipTime !== null && !disabled && <span className="media-seek-tooltip" aria-hidden="true">
      {formatMediaTime(tooltipTime)}
    </span>}
  </div>;
};
