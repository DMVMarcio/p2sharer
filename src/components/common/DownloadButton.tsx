import { WebsiteLink } from './WebsiteLink';
import { Download } from 'lucide-react';
import { useLocale } from '../../hooks/useLocale';
import { t } from '../../i18n';
import { websiteUrl } from '../../platform/website';

export function DownloadButton({ compact = false, newTab = false }: { compact?: boolean; newTab?: boolean }) {
  useLocale();
  return <WebsiteLink className={`btn btn-secondary download-link${compact ? ' btn-sm' : ''}`} href={websiteUrl('/download')}
    target={newTab ? '_blank' : undefined} rel={newTab ? 'noopener noreferrer' : undefined}>
    <Download size={compact ? 15 : 18} aria-hidden="true" />{t(compact ? 'common.download' : 'downloads.title')}
  </WebsiteLink>;
}
