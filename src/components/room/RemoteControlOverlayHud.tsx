import React from 'react';
import { Gamepad2, Keyboard, Mouse } from 'lucide-react';
import type { RemoteControllerOverlayItem } from '../../core/stream/remote_control_activity';

interface RemoteControlOverlayHudProps {
  items: RemoteControllerOverlayItem[];
  compact?: boolean;
}

export const RemoteControlOverlayHud: React.FC<RemoteControlOverlayHudProps> = ({
  items,
  compact = false,
}) => {
  if (!items.length) return null;

  return (
    <div className={`rc-host-overlay-hud ${compact ? 'is-compact' : ''}`} aria-hidden="true">
      {items.map((item) => {
        const anyActive = item.mouseActive || item.keyboardActive || item.gamepadActive;
        const initial = (item.name || '?').trim().charAt(0).toUpperCase() || '?';
        const devices = [
          item.mouseEnabled && {
            key: 'mouse',
            active: item.mouseActive,
            seq: item.mouseSeq,
            Icon: Mouse,
          },
          item.keyboardEnabled && {
            key: 'keyboard',
            active: item.keyboardActive,
            seq: item.keyboardSeq,
            Icon: Keyboard,
          },
          item.gamepadEnabled && {
            key: 'gamepad',
            active: item.gamepadActive,
            seq: item.gamepadSeq,
            Icon: Gamepad2,
          },
        ].filter(Boolean) as Array<{
          key: string;
          active: boolean;
          seq: number;
          Icon: typeof Mouse;
        }>;

        return (
          <div
            key={item.peerId}
            className={`rc-hud-pill ${anyActive ? 'has-activity' : ''}`}
          >
            <span className="rc-hud-avatar" style={{ backgroundColor: item.color }}>
              {item.avatarDataUrl ? (
                <img src={item.avatarDataUrl} alt="" />
              ) : (
                <span>{initial}</span>
              )}
            </span>
            <span className="rc-hud-name">{item.name}</span>
            {devices.length > 0 && (
              <span className="rc-hud-devices">
                {devices.map(({ key, active, seq, Icon }) => (
                  <span
                    key={key}
                    className={`rc-hud-device ${active ? `is-input-active ${seq % 2 === 0 ? 'flash-a' : 'flash-b'}` : 'is-idle'}`}
                  >
                    <Icon size={compact ? 11 : 13} />
                  </span>
                ))}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};
