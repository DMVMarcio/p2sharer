import React, { useCallback, useState } from 'react';
import { ChevronDown, HeadphoneOff, Headphones, Mic, MicOff } from 'lucide-react';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useRoom } from '../../hooks/useRoom';
import { roomService } from '../../services/room_service';
import { Tooltip } from '../common/Tooltip';
import { VoiceQuickPopover } from './VoiceQuickPopover';

export const VoiceControlsBar: React.FC = () => {
  useLocale();
  const { voiceMicMuted, voiceDeafened, isLocalSpeaking } = useRoom();
  const [popover, setPopover] = useState<{ panel: 'input' | 'output'; anchorEl: HTMLElement } | null>(null);

  const isMuted = voiceMicMuted ?? true;
  const isDeafened = Boolean(voiceDeafened);

  const closePopover = useCallback(() => {
    setPopover(null);
  }, []);

  const togglePopover = (panel: 'input' | 'output', target: HTMLElement) => {
    setPopover((current) => {
      if (current && current.panel === panel && current.anchorEl === target) {
        return null;
      }
      return { panel, anchorEl: target };
    });
  };

  return (
    <div className="voice-controls-bar" role="group" aria-label={t('voice.controlsGroupAria')}>
      <div className="voice-control-split">
        <Tooltip content={isMuted ? t('voice.unmuteMic') : t('voice.muteMic')}>
          <button
            type="button"
            id="btn-voice-mute"
            className={`btn btn-sm btn-compact voice-split-main ${isMuted ? 'btn-danger is-muted' : 'btn-outline'} ${isLocalSpeaking && !isMuted ? 'is-speaking' : ''}`}
            aria-pressed={isMuted}
            aria-label={isMuted ? t('voice.unmuteMic') : t('voice.muteMic')}
            onClick={() => void roomService.toggleVoiceMute?.()}
          >
            {isMuted ? <MicOff size={14} aria-hidden="true" /> : <Mic size={14} aria-hidden="true" />}
          </button>
        </Tooltip>
        <Tooltip content={t('voice.configureInput')}>
          <button
            type="button"
            id="btn-voice-input-config"
            className={`btn btn-sm btn-outline btn-compact voice-split-chevron${popover?.panel === 'input' ? ' active' : ''}`}
            aria-label={t('voice.configureInput')}
            aria-haspopup="dialog"
            aria-expanded={popover?.panel === 'input'}
            onClick={(event) => togglePopover('input', event.currentTarget)}
          >
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>

      <div className="voice-control-split">
        <Tooltip content={isDeafened ? t('voice.undeafen') : t('voice.deafen')}>
          <button
            type="button"
            id="btn-voice-deafen"
            className={`btn btn-sm btn-compact voice-split-main ${isDeafened ? 'btn-danger is-deafened' : 'btn-outline'}`}
            aria-pressed={isDeafened}
            aria-label={isDeafened ? t('voice.undeafen') : t('voice.deafen')}
            onClick={() => roomService.toggleVoiceDeafen?.()}
          >
            {isDeafened ? <HeadphoneOff size={14} aria-hidden="true" /> : <Headphones size={14} aria-hidden="true" />}
          </button>
        </Tooltip>
        <Tooltip content={t('voice.configureOutput')}>
          <button
            type="button"
            id="btn-voice-output-config"
            className={`btn btn-sm btn-outline btn-compact voice-split-chevron${popover?.panel === 'output' ? ' active' : ''}`}
            aria-label={t('voice.configureOutput')}
            aria-haspopup="dialog"
            aria-expanded={popover?.panel === 'output'}
            onClick={(event) => togglePopover('output', event.currentTarget)}
          >
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>

      <VoiceQuickPopover
        panel={popover?.panel ?? null}
        anchorEl={popover?.anchorEl ?? null}
        onClose={closePopover}
      />
    </div>
  );
};
