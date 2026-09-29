import React from 'react';
import { Captions, CaptionsOff, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { MediaSeekBar } from '../components/common/MediaSeekBar';
import { TooltipButton } from '../components/common/TooltipButton';
import { formatMediaTime } from '../core/media_time';

interface Props {
  hasVideo: boolean;
  playing: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  position: number;
  duration: number;
  buffered: number;
  volume: number;
  muted: boolean;
  captions: boolean;
  onTogglePlayback: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeek: (position: number) => void;
  onVolume: (volume: number) => void;
  onToggleMute: () => void;
  onToggleCaptions: () => void;
}

export const YouTubeControls: React.FC<Props> = ({ hasVideo, playing, hasPrevious, hasNext,
  position, duration, buffered, volume, muted, onTogglePlayback, onPrevious, onNext, onSeek,
  onVolume, onToggleMute, captions, onToggleCaptions }) => {
  return <div className="youtube-control-deck" aria-label="Controles de reprodução compartilhada">
    <MediaSeekBar value={position} duration={duration} buffered={buffered} onCommit={onSeek}
      disabled={!hasVideo || duration <= 0} />
    <div className="youtube-control-row">
      <div className="youtube-transport">
        <TooltipButton tooltip="Vídeo anterior" className="youtube-control-button"
          disabled={!hasVideo || (!hasPrevious && position < 1)} onClick={onPrevious}>
          <SkipBack size={18} strokeWidth={2} /></TooltipButton>
        <TooltipButton tooltip={playing ? 'Pausar para todos' : 'Reproduzir para todos'}
          className="youtube-control-button youtube-play-button" disabled={!hasVideo} onClick={onTogglePlayback}>
          {playing ? <Pause size={19} strokeWidth={2.4} /> : <Play size={19} strokeWidth={2.4} />}
        </TooltipButton>
        <TooltipButton tooltip="Próximo vídeo" className="youtube-control-button"
          disabled={!hasNext} onClick={onNext}><SkipForward size={18} strokeWidth={2} /></TooltipButton>
        <span className="youtube-time-readout">{formatMediaTime(position)} <span>/</span> {formatMediaTime(duration)}</span>
      </div>
      <div className="youtube-volume-control">
        <TooltipButton tooltip={captions ? 'Desativar legendas' : 'Ativar legendas'}
          className={`youtube-control-button ${captions ? 'youtube-captions-active' : ''}`}
          aria-pressed={captions} onClick={onToggleCaptions}>
          {captions ? <Captions size={18} /> : <CaptionsOff size={18} />}
        </TooltipButton>
        <TooltipButton tooltip={muted ? 'Ativar som' : 'Silenciar'} className="youtube-control-button"
          onClick={onToggleMute}>
          {muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </TooltipButton>
        <input aria-label="Volume do YouTube" type="range" min="0" max="100" value={volume}
          onChange={(event) => onVolume(Number(event.target.value))}
          style={{ '--volume-progress': `${muted ? 0 : volume}%` } as React.CSSProperties} />
        <span>{muted ? 0 : volume}%</span>
      </div>
    </div>
  </div>;
};
