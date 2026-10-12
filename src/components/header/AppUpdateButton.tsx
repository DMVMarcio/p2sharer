import { Download } from 'lucide-react';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useAppUpdates } from '../../hooks/useAppUpdates';
import { appUpdates } from '../../services/app_updates';
import { Tooltip } from '../common/Tooltip';

export function AppUpdateButton() {
  useLocale();
  const update = useAppUpdates();
  if (!update.version) return null;
  const label = t('message.0986025090c9', { v0: update.version });
  return <Tooltip content={label}>
    <button type="button" className="btn btn-secondary btn-sm app-update-badge" onClick={appUpdates.open} aria-label={label}>
      <Download size={12} className="app-update-badge-icon" aria-hidden="true" />
      <span>{t('message.0d52ab3423d3')}</span>
    </button>
  </Tooltip>;
}
