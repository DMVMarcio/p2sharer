import { Volume1, Volume2, VolumeX } from 'lucide-react';
import { TooltipButton } from './TooltipButton';

interface Props {
  volume: number;
  muted: boolean;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
  label: string;
  muteLabel: string;
  unmuteLabel: string;
}

/** A single speaker control with the stream cards' mute/restore semantics. */
export function MediaVolumeControl({ volume, muted, onVolumeChange, onToggleMute, label, muteLabel, unmuteLabel }: Props) {
  const silent = muted || volume === 0;
  return <div className="media-volume-control" role="group" aria-label={label} onClick={event => event.stopPropagation()}>
    <TooltipButton className="btn btn-secondary btn-sm media-volume-toggle" tooltip={silent ? unmuteLabel : muteLabel}
      aria-pressed={silent} onClick={onToggleMute}>
      {silent ? <VolumeX size={15} /> : volume < 0.5 ? <Volume1 size={15} /> : <Volume2 size={15} />}
    </TooltipButton>
    <input className="settings-slider-input" autoComplete="off" type="range" min="0" max="100" step="1"
      value={silent ? 0 : Math.round(volume * 100)} aria-label={label} aria-valuetext={`${silent ? 0 : Math.round(volume * 100)}%`}
      onChange={event => onVolumeChange(Number(event.target.value) / 100)} />
  </div>;
}
