import { WebsiteLink } from '../../src/components/common/WebsiteLink';
import { DownloadPanel } from '../../src/components/common/DownloadPanel';
import { ArrowUpRight, ShieldAlert } from 'lucide-react';
import { useLocale } from '../../src/hooks/useLocale';
import { t } from '../../src/i18n';

const CODE_SIGNING_POLICY_URL = 'https://github.com/DMVMarcio/p2sharer#code-signing-policy';

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
      <div className="site-download-main">
        <DownloadPanel />
        <aside className="site-download-notice" aria-labelledby="download-signing-heading">
          <ShieldAlert size={18} className="site-download-notice-icon" aria-hidden="true" />
          <div className="site-download-notice-copy">
            <h2 id="download-signing-heading">{t('downloads.signingNoticeTitle')}</h2>
            <p>{t('downloads.signingNoticeBody')}</p>
            <WebsiteLink href={CODE_SIGNING_POLICY_URL} target="_blank" rel="noopener noreferrer">
              {t('downloads.signingPolicyLink')}
              <ArrowUpRight size={14} aria-hidden="true" />
            </WebsiteLink>
          </div>
        </aside>
      </div>
    </section>
  );
}

export default DownloadsPage;
