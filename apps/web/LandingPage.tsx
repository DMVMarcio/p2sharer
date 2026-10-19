import { DownloadButton } from '../../src/components/common/DownloadButton';
import { DownloadPanel } from '../../src/components/common/DownloadPanel';
import { ArrowUpRight, FileText, Monitor, Network, Pencil, Play } from 'lucide-react';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useLocale } from '../../src/hooks/useLocale';
import { t, getLanguage, setLanguage } from '../../src/i18n';
import { LANGUAGE_OPTIONS } from '../../src/i18n/language';
import { Select } from '../../src/components/common/Select';
import { ContextMenuProvider } from '../../src/components/common/ContextMenu';
import logo from '../../src/assets/logo_right_bottom.png';

const features = [
  { icon: Monitor, title: 'web.mediaTitle', description: 'web.mediaText' },
  { icon: Pencil, title: 'web.createTitle', description: 'web.createText' },
  { icon: Network, title: 'web.p2pTitle', description: 'web.p2pText' },
];

export function LandingPage() {
  useAppTheme(); useLocale();
  return <ContextMenuProvider><div className="site-shell">
    <a className="site-skip" href="#content">{t('web.skip')}</a>
    <header className="site-header">
      <a className="site-brand" href="/" aria-label="P2Sharer"><img src={logo} alt="" />P2Sharer</a>
      <nav aria-label={t('web.navigation')}>
        <Select aria-label={t('web.language')} value={getLanguage()} options={LANGUAGE_OPTIONS}
          onValueChange={value => setLanguage(value as ReturnType<typeof getLanguage>)} />
        <a className="btn btn-secondary" href="/app">{t('web.open')}<ArrowUpRight size={16} aria-hidden="true" /></a>
      </nav>
    </header>
    <main id="content">
      {location.pathname === '/download' ? <div className="site-download"><h1>{t('downloads.title')}</h1><DownloadPanel /></div> : <>
      <section className="site-hero">
        <div>
          <p className="site-eyebrow">{t('web.eyebrow')}</p>
          <h1>{t('home.headline')}</h1>
          <p className="site-description">{t('home.description')}</p>
          <div className="site-actions">
            <a className="btn btn-primary" href="/app">{t('web.open')}<ArrowUpRight size={18} aria-hidden="true" /></a>
            <DownloadButton />
          </div>
          <p className="site-note">{t('web.noAccount')}</p>
        </div>
        <div className="site-art" aria-hidden="true">
          <img src={logo} alt="" />
          <div className="site-orbit"><Monitor /><FileText /><Play /></div>
        </div>
      </section>
      <section className="site-features" aria-label={t('web.features')}>
        {features.map(({ icon: Icon, title, description }) => <article key={title}>
          <Icon className="site-feature-icon" size={25} aria-hidden="true" />
          <h2>{t(title)}</h2><p>{t(description)}</p>
        </article>)}
      </section>
      <section className="site-platforms">
        <div><p className="site-eyebrow">{t('web.platformTitle')}</p><h2>{t('web.platformHeading')}</h2></div>
        <div><p>{t('web.platformText')}</p><a className="btn btn-primary" href="/app">{t('web.open')}<ArrowUpRight size={17} aria-hidden="true" /></a></div>
      </section>
      </>}
    </main>
    <footer className="site-footer"><span>P2Sharer</span><a href="https://github.com/DMVMarcio/p2sharer" target="_blank" rel="noopener noreferrer">GitHub<ArrowUpRight size={14} aria-hidden="true" /></a></footer>
  </div></ContextMenuProvider>;
}
