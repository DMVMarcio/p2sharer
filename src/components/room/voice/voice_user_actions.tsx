import { Volume2, VolumeX } from 'lucide-react';
import { t } from '../../../i18n';
import { roomService } from '../../../services/room_service';
import type { ContextMenuAction } from '../../common/overlays/ContextMenu';

export function getUserVoiceActions(target: {
  peerId: string;
  publicKey?: string;
  username: string;
}): ContextMenuAction[] {
  const { peerId, publicKey, username } = target;
  const saved = roomService.getPeerVoiceVolume?.(peerId, publicKey, username) ?? {
    volume: 100,
    muted: false,
  };

  return [
    {
      id: `voice-volume-${peerId}`,
      get label() {
        return t('voice.userVolumeLabel');
      },
      icon: <Volume2 size={15} />,
      separator: true,
      slider: {
        value: saved.volume,
        min: 0,
        max: 200,
        step: 1,
        defaultValue: 100,
        formatValue: (val) => `${val}%`,
        onChange: (nextVol) => {
          roomService.setPeerVoiceVolume?.(peerId, nextVol, false, publicKey, username);
        },
      },
    },
    {
      id: `voice-mute-${peerId}`,
      get label() {
        return saved.muted ? t('voice.unmuteUser') : t('voice.muteUser');
      },
      icon: saved.muted ? <Volume2 size={15} /> : <VolumeX size={15} />,
      onSelect: () => {
        const current = roomService.getPeerVoiceVolume?.(peerId, publicKey, username) ?? {
          volume: 100,
          muted: false,
        };
        roomService.setPeerVoiceVolume?.(peerId, current.volume, !current.muted, publicKey, username);
      },
    },
  ];
}
