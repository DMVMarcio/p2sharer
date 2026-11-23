import React, { useCallback, useState } from 'react';
import { ChevronDown, HeadphoneOff, Headphones, Mic, MicOff, PhoneCall, PhoneOff } from 'lucide-react';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useRoom } from '../../hooks/useRoom';
import { roomService } from '../../services/room_service';
import { Tooltip } from '../common/Tooltip';
import { VoiceQuickPopover } from './VoiceQuickPopover';

export const VoiceControlsBar: React.FC = () => {
  useLocale();
  const { inVoice, voiceMicMuted, voiceDeafened, isLocalSpeaking, voicePeers } = useRoom();
  const [popover, setPopover] = useState<{ panel: 'input' | 'output'; anchorEl: HTMLElement } | null>(null);

  const remoteVoiceCount = Object.values(voicePeers ?? {}).filter((peer) => peer.inVoice).length;
  const totalVoiceCount = remoteVoiceCount + (inVoice ? 1 : 0);

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
      {!inVoice ? (
        <div className="voice-control-split">
          <Tooltip content={t('voice.joinCallTooltip')}>
            <button
              type="button"
              id="btn-join-voice"
              className="btn btn-sm btn-outline btn-compact voice-split-main"
              onClick={() => void roomService.joinVoice?.()}
              aria-label={t('voice.joinCall')}
            >
              <PhoneCall size={14} aria-hidden="true" />
              <span className="btn-text">{t('voice.joinCall')}</span>
              {totalVoiceCount > 0 && (
                <span className="voice-count-badge" aria-label={t('voice.inVoiceCount', { count: totalVoiceCount })}>
                  {totalVoiceCount}
                </span>
              )}
            </button>
          </Tooltip>
          <Tooltip content={t('voice.configureInput')}>
            <button
              type="button"
              id="btn-voice-config-idle"
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
      ) : (
        <>
          <div className="voice-control-split">
            <Tooltip content={voiceMicMuted ? t('voice.unmuteMic') : t('voice.muteMic')}>
              <button
                type="button"
                id="btn-voice-mute"
                className={`btn btn-sm btn-compact voice-split-main ${voiceMicMuted ? 'btn-danger is-muted' : 'btn-outline'} ${isLocalSpeaking && !voiceMicMuted ? 'is-speaking' : ''}`}
                aria-pressed={voiceMicMuted}
                aria-label={voiceMicMuted ? t('voice.unmuteMic') : t('voice.muteMic')}
                onClick={() => roomService.toggleVoiceMute?.()}
              >
                {voiceMicMuted ? <MicOff size={14} aria-hidden="true" /> : <Mic size={14} aria-hidden="true" />}
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
            <Tooltip content={voiceDeafened ? t('voice.undeafen') : t('voice.deafen')}>
              <button
                type="button"
                id="btn-voice-deafen"
                className={`btn btn-sm btn-compact voice-split-main ${voiceDeafened ? 'btn-danger is-deafened' : 'btn-outline'}`}
                aria-pressed={voiceDeafened}
                aria-label={voiceDeafened ? t('voice.undeafen') : t('voice.deafen')}
                onClick={() => roomService.toggleVoiceDeafen?.()}
              >
                {voiceDeafened ? <HeadphoneOff size={14} aria-hidden="true" /> : <Headphones size={14} aria-hidden="true" />}
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

          <Tooltip content={t('voice.leaveCall')}>
            <button
              type="button"
              id="btn-leave-voice"
              className="btn btn-sm btn-danger btn-compact voice-disconnect-btn"
              aria-label={t('voice.leaveCall')}
              onClick={() => roomService.leaveVoice?.()}
            >
              <PhoneOff size={14} aria-hidden="true" />
            </button>
          </Tooltip>
        </>
      )}

      <VoiceQuickPopover
        panel={popover?.panel ?? null}
        anchorEl={popover?.anchorEl ?? null}
        onClose={closePopover}
      />
    </div>
  );
};
