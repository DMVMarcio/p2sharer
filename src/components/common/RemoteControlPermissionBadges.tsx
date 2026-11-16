import React from 'react';
import { Gamepad2, Keyboard, Mouse } from 'lucide-react';
import type { ControllerInputActivity } from '../../core/remote_control_activity';
import { t } from '../../i18n';
import { Tooltip } from './Tooltip';

export type RemoteControlPermissionKey = 'mouseEnabled' | 'keyboardEnabled' | 'gamepadEnabled';

interface RemoteControlPermissionBadgesProps {
  mouseEnabled: boolean;
  keyboardEnabled: boolean;
  gamepadEnabled: boolean;
  onToggle: (key: RemoteControlPermissionKey, next: boolean) => void;
  activity?: ControllerInputActivity;
  subjectName?: string;
  compact?: boolean;
  disabled?: boolean;
  className?: string;
}

export const RemoteControlPermissionBadges: React.FC<RemoteControlPermissionBadgesProps> = ({
  mouseEnabled,
  keyboardEnabled,
  gamepadEnabled,
  onToggle,
  activity,
  subjectName,
  compact = false,
  disabled = false,
  className = '',
}) => {
  const items: ReadonlyArray<{
    key: RemoteControlPermissionKey;
    enabled: boolean;
    activeInput: boolean;
    seq: number;
    label: string;
    ariaLabel: string;
    Icon: typeof Mouse;
  }> = [
    {
      key: 'mouseEnabled',
      enabled: mouseEnabled,
      activeInput: Boolean(mouseEnabled && activity?.mouseActive),
      seq: activity?.mouseSeq ?? 0,
      label: t('remoteControl.mousePermission'),
      ariaLabel: subjectName
        ? t('remoteControl.mousePermissionAria', { name: subjectName })
        : t('remoteControl.mousePermission'),
      Icon: Mouse,
    },
    {
      key: 'keyboardEnabled',
      enabled: keyboardEnabled,
      activeInput: Boolean(keyboardEnabled && activity?.keyboardActive),
      seq: activity?.keyboardSeq ?? 0,
      label: t('remoteControl.keyboardPermission'),
      ariaLabel: subjectName
        ? t('remoteControl.keyboardPermissionAria', { name: subjectName })
        : t('remoteControl.keyboardPermission'),
      Icon: Keyboard,
    },
    {
      key: 'gamepadEnabled',
      enabled: gamepadEnabled,
      activeInput: Boolean(gamepadEnabled && activity?.gamepadActive),
      seq: activity?.gamepadSeq ?? 0,
      label: t('remoteControl.gamepadPermission'),
      ariaLabel: subjectName
        ? t('remoteControl.gamepadPermissionAria', { name: subjectName })
        : t('remoteControl.gamepadPermission'),
      Icon: Gamepad2,
    },
  ];

  return (
    <div
      className={`rc-perm-badges ${compact ? 'is-compact' : ''} ${className}`.trim()}
      role="group"
      aria-label={t('remoteControl.permissionsGroupLabel')}
    >
      {items.map(({ key, enabled, activeInput, seq, label, ariaLabel, Icon }) => {
        const flashClass = activeInput ? `is-input-active ${seq % 2 === 0 ? 'flash-a' : 'flash-b'}` : '';
        const button = (
          <button
            key={key}
            type="button"
            disabled={disabled}
            aria-pressed={enabled}
            aria-label={ariaLabel}
            className={`rc-perm-badge ${enabled ? 'is-enabled' : 'is-disabled'} ${compact ? 'is-compact' : ''} ${flashClass}`.trim()}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(key, !enabled);
            }}
          >
            <Icon size={compact ? 13 : 14} className="rc-perm-badge-icon" aria-hidden="true" />
            {!compact && <span>{label}</span>}
          </button>
        );
        return compact ? (
          <Tooltip key={key} content={`${label}: ${enabled ? t('remoteControl.permActive') : t('remoteControl.permBlocked')}`}>
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
};
