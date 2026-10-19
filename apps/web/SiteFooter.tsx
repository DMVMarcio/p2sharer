import { ArrowUpRight } from 'lucide-react';
import { t } from '../../src/i18n';
import { useLocale } from '../../src/hooks/useLocale';
import logo from '../../src-tauri/icons/128x128@2x.png';

const repository = 'https://github.com/DMVMarcio/p2sharer';

export function SiteFooter() {
  useLocale();
  return <footer className="site-footer">
    <div className="site-footer-main">
      <div className="site-footer-identity"><a className="site-brand" href="/"><img src={logo} alt="" />P2Sharer</a><p>{t('web.p2pTitle')}</p></div>
      <nav aria-label="P2Sharer"><h2>P2Sharer</h2><a href="/app">{t('web.useWeb')}</a><a href="/download">{t('downloads.title')}</a></nav>
      <nav aria-label="GitHub"><h2>GitHub</h2>
        <a href={repository} target="_blank" rel="noopener noreferrer">{t('web.sourceCode')}<ArrowUpRight size={13} aria-hidden="true" /></a>
        <a href={`${repository}/releases`} target="_blank" rel="noopener noreferrer">{t('releaseNotes.view')}<ArrowUpRight size={13} aria-hidden="true" /></a>
        <a href={`${repository}/issues`} target="_blank" rel="noopener noreferrer">{t('web.issues')}<ArrowUpRight size={13} aria-hidden="true" /></a>
      </nav>
    </div>
    <div className="site-footer-bottom"><span>© {new Date().getFullYear()} P2Sharer</span><span>Windows · Web</span></div>
  </footer>;
}
