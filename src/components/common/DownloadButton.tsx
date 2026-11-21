import { WebsiteLink } from './WebsiteLink';
import { Download } from 'lucide-react';
import { useLocale } from '../../hooks/useLocale';
import { t } from '../../i18n';
import { websiteUrl } from '../../platform/website';

export function DownloadButton({ compact = false, newTab = false, variant = 'secondary' }: { compact?: boolean; newTab?: boolean; variant?: 'primary' | 'secondary' }) {
  useLocale();
  return <WebsiteLink className={`btn btn-${variant} download-link${compact ? ' btn-sm' : ''}`} href={websiteUrl('/download')}
    target={newTab ? '_blank' : undefined} rel={newTab ? 'noopener noreferrer' : undefined}>
    <Download size={compact ? 15 : 18} aria-hidden="true" />{t(compact ? 'common.download' : 'downloads.title')}
  </WebsiteLink>;
}
