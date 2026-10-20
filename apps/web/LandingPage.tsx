import { Outlet, useLocation } from 'react-router';
import { WebsiteLink } from '../../src/components/common/WebsiteLink';
import { DownloadButton } from '../../src/components/common/DownloadButton';
import { SiteFooter } from './SiteFooter';
import { ArrowUpRight, Monitor, Network, Pencil } from 'lucide-react';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useLocale } from '../../src/hooks/useLocale';
import { t, getLanguage, setLanguage } from '../../src/i18n';
import { LANGUAGE_OPTIONS } from '../../src/i18n/language';
import { Select } from '../../src/components/common/Select';
import artwork from '../../src/assets/logo_right_bottom.webp';
import logo from '../../src/assets/logo.png';

export { DownloadsPage } from './DownloadsPage';

const features = [
  { icon: Monitor, title: 'web.mediaTitle', description: 'web.mediaText' },
  { icon: Pencil, title: 'web.createTitle', description: 'web.createText' },
  { icon: Network, title: 'web.p2pTitle', description: 'web.p2pText' },
];

export function SiteLayout() {
  const location = useLocation();
  useAppTheme(); useLocale();
  return <div className="site-shell">
    <WebsiteLink className="site-skip" href="#content">{t('web.skip')}</WebsiteLink>
    <header className="site-header">
      <WebsiteLink className="site-brand" href="/" aria-label="P2Sharer"><img src={logo} alt="" />P2Sharer</WebsiteLink>
      <nav aria-label={t('web.navigation')}>
        <Select aria-label={t('web.language')} value={getLanguage()} options={LANGUAGE_OPTIONS.map(option => ({ ...option, icon: <img src={`/flags/${option.flag}.svg`} alt="" width={20} height={15} draggable={false} /> }))}
          onValueChange={value => setLanguage(value as ReturnType<typeof getLanguage>)} />
        <WebsiteLink className="btn btn-secondary" href="/app">{t(location.pathname === '/download' ? 'web.useWeb' : 'web.open')}<ArrowUpRight size={16} aria-hidden="true" /></WebsiteLink>
      </nav>
    </header>
    <main id="content" tabIndex={-1}>
      <Outlet />
    </main>
    <SiteFooter />
  </div>;
}

export function LandingPage() {
  useLocale();
  return <>
      <section className="site-hero">
        <div className="site-hero-content">
          <h1>{t('home.headline')}</h1>
          <p className="site-description">{t('home.description')}</p>
          <div className="site-actions">
            <WebsiteLink className="btn btn-primary" href="/app">{t('web.open')}<ArrowUpRight size={18} aria-hidden="true" /></WebsiteLink>
            <DownloadButton />
          </div>
          <p className="site-note">{t('web.noAccount')}</p>
        </div>
        <div className="site-art" aria-hidden="true">
          <img src={artwork} alt="" className="site-art-logo" />
        </div>
      </section>
      <section className="site-features" aria-label={t('web.features')}>
        {features.map(({ icon: Icon, title, description }) => <article key={title}>
          <Icon className="site-feature-icon" size={25} aria-hidden="true" />
          <h2>{t(title)}</h2><p>{t(description)}</p>
        </article>)}
      </section>
      </>;
}
