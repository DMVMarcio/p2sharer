import { MonitorCog } from 'lucide-react';
import type { RemoteControlStatus } from '../../core/stream/remote_control.ts';
import { useLocale } from '../../hooks/useLocale';
import { t } from '../../i18n';
import { Tooltip } from '../common/Tooltip';

export function RemoteControlToggle({
  status,
  onToggle,
  onTooltipOpenChange,
}: {
  status: RemoteControlStatus;
  onToggle: () => void;
  onTooltipOpenChange?: (open: boolean) => void;
}) {
  useLocale();
  const label =
    status === 'active'
      ? t('remoteControl.stopAction')
      : status === 'pending'
        ? t('remoteControl.cancelRequestAction')
        : t('remoteControl.requestAction');
  const pressed = status === 'active' || status === 'pending';

  return (
    <Tooltip content={label} onOpenChange={onTooltipOpenChange}>
      <button
        type="button"
        className={`btn-stream-pin remote-control-toggle ${status === 'active' ? 'active' : ''} ${status === 'pending' ? 'pending' : ''}`}
        aria-label={label}
        aria-pressed={pressed}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        <MonitorCog size={15} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
