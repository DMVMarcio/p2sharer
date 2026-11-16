import React from 'react';
import { Gamepad2, Keyboard, Mouse } from 'lucide-react';
import { t } from '../../i18n';
import { Tooltip } from './Tooltip';

export type RemoteControlPermissionKey = 'mouseEnabled' | 'keyboardEnabled' | 'gamepadEnabled';

interface RemoteControlPermissionBadgesProps {
  mouseEnabled: boolean;
  keyboardEnabled: boolean;
  gamepadEnabled: boolean;
  onToggle: (key: RemoteControlPermissionKey, next: boolean) => void;
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
  subjectName,
  compact = false,
  disabled = false,
  className = '',
}) => {
  const items: ReadonlyArray<{
    key: RemoteControlPermissionKey;
    enabled: boolean;
    label: string;
    ariaLabel: string;
    Icon: typeof Mouse;
  }> = [
    {
      key: 'mouseEnabled',
      enabled: mouseEnabled,
      label: t('remoteControl.mousePermission'),
      ariaLabel: subjectName
        ? t('remoteControl.mousePermissionAria', { name: subjectName })
        : t('remoteControl.mousePermission'),
      Icon: Mouse,
    },
    {
      key: 'keyboardEnabled',
      enabled: keyboardEnabled,
      label: t('remoteControl.keyboardPermission'),
      ariaLabel: subjectName
        ? t('remoteControl.keyboardPermissionAria', { name: subjectName })
        : t('remoteControl.keyboardPermission'),
      Icon: Keyboard,
    },
    {
      key: 'gamepadEnabled',
      enabled: gamepadEnabled,
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
      {items.map(({ key, enabled, label, ariaLabel, Icon }) => {
        const button = (
          <button
            key={key}
            type="button"
            disabled={disabled}
            aria-pressed={enabled}
            aria-label={ariaLabel}
            className={`rc-perm-badge ${enabled ? 'is-enabled' : 'is-disabled'} ${compact ? 'is-compact' : ''}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(key, !enabled);
            }}
          >
            <Icon size={compact ? 13 : 14} aria-hidden="true" />
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
