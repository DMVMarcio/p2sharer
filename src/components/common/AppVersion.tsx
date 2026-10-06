import { version } from '../../../package.json';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';

interface Props {
  compact?: boolean;
  targetVersion?: string | null;
}

/** Release tooling keeps this bundled version synchronized with the native app. */
export function AppVersion({ compact = false, targetVersion }: Props) {
  useLocale();
  const installed = t('appVersion.installed', { version });
  return <span className={`app-version${compact ? ' app-version-compact' : ''}`}
    aria-label={compact ? installed : undefined}>
    {compact ? `v${version}` : installed}
    {targetVersion && <> → {t('appVersion.target', { version: targetVersion })}</>}
  </span>;
}
