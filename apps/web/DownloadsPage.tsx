import { WebsiteLink } from '../../src/components/common/WebsiteLink';
import { DownloadPanel } from '../../src/components/common/DownloadPanel';
import { ArrowUpRight } from 'lucide-react';
import { useLocale } from '../../src/hooks/useLocale';
import { t } from '../../src/i18n';

export function DownloadsPage() {
  useLocale();
  return (
    <section className="site-download">
      <div className="site-download-intro">
        <h1>{t('downloads.title')}</h1>
        <p>{t('downloads.intro')}</p>
        <WebsiteLink className="btn btn-secondary" href="/app">
          {t('web.useWeb')}
          <ArrowUpRight size={16} aria-hidden="true" />
        </WebsiteLink>
      </div>
      <DownloadPanel />
    </section>
  );
}

export default DownloadsPage;
