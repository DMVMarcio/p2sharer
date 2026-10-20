import { WebsiteLink } from '../../src/components/common/WebsiteLink';
import { ArrowUpRight } from 'lucide-react';
import { t } from '../../src/i18n';
import { useLocale } from '../../src/hooks/useLocale';
import logo from '../../src/assets/logo.png';

const repository = 'https://github.com/DMVMarcio/p2sharer';

export function SiteFooter() {
  useLocale();
  return <footer className="site-footer">
    <div className="site-footer-main">
      <div className="site-footer-identity"><WebsiteLink className="site-brand" href="/"><img src={logo} alt="" />P2Sharer</WebsiteLink><p>{t('web.p2pTitle')}</p></div>
      <nav aria-label="P2Sharer"><h2>P2Sharer</h2><WebsiteLink href="/app">{t('web.useWeb')}</WebsiteLink><WebsiteLink href="/download">{t('downloads.title')}</WebsiteLink></nav>
      <nav aria-label="GitHub"><h2>GitHub</h2>
        <WebsiteLink href={repository} target="_blank" rel="noopener noreferrer">{t('web.sourceCode')}<ArrowUpRight size={13} aria-hidden="true" /></WebsiteLink>
        <WebsiteLink href={`${repository}/releases`} target="_blank" rel="noopener noreferrer">{t('releaseNotes.view')}<ArrowUpRight size={13} aria-hidden="true" /></WebsiteLink>
        <WebsiteLink href={`${repository}/issues`} target="_blank" rel="noopener noreferrer">{t('web.issues')}<ArrowUpRight size={13} aria-hidden="true" /></WebsiteLink>
      </nav>
    </div>
    <div className="site-footer-bottom"><span>© {new Date().getFullYear()} P2Sharer</span></div>
  </footer>;
}
