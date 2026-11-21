import { useRef, type CSSProperties } from 'react';
import { Outlet, useLocation } from 'react-router';
import { WebsiteLink } from '../../src/components/common/WebsiteLink';
import { DownloadButton } from '../../src/components/common/DownloadButton';
import { SiteFooter } from './SiteFooter';
import {
  ArrowUpRight,
  Check,
  Crown,
  FolderUp,
  Gamepad2,
  Globe,
  Monitor,
  ShieldCheck,
  Tv,
  UserCheck,
} from 'lucide-react';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useLocale } from '../../src/hooks/useLocale';
import { t, getLanguage, setLanguage } from '../../src/i18n';
import { LANGUAGE_OPTIONS } from '../../src/i18n/language';
import { Select } from '../../src/components/common/Select';
import logo from '../../src/assets/logo.png';
import { HeroRoomPreview } from './landing/HeroRoomPreview';
import { FilesDemo, PlayCreateDemo, RemoteDemo, Showcase, StreamDemo, WatchDemo, type Tone } from './landing/Showcase';
import { P2PJourney } from './landing/P2PJourney';
import { AppDock } from './landing/AppDock';
import { useScrollReveal } from './landing/motion';
import './landing/landing.css';

export { DownloadsPage } from './DownloadsPage';

const specs: { metric: string; value: string; tone: Tone }[] = [
  { metric: '4K / 120 FPS', value: 'web.specStreamValue', tone: 'violet' },
  { metric: '∞ P2P', value: 'web.specFilesValue', tone: 'emerald' },
  { metric: 'DTLS-SRTP', value: 'web.specSecurityValue', tone: 'sky' },
  { metric: '$0 • MIT', value: 'web.specCostValue', tone: 'amber' },
];

const platformItems = {
  web: ['web.platformWebItem1', 'web.platformWebItem2', 'web.platformWebItem3', 'web.platformWebItem4'],
  desktop: ['web.platformDesktopItem1', 'web.platformDesktopItem2', 'web.platformDesktopItem3', 'web.platformDesktopItem4'],
} as const;

export function SiteLayout() {
  const location = useLocation();
  const isLanding = location.pathname === '/';
  useAppTheme();
  useLocale();
  return (
    <div className="site-shell">
      <WebsiteLink className="site-skip" href="#content">
        {t('web.skip')}
      </WebsiteLink>
      <header className="site-header">
        <div className="site-header-start">
          <WebsiteLink className="site-brand" href="/" aria-label="P2Sharer">
            <img src={logo} alt="" />
            P2Sharer
          </WebsiteLink>
          {isLanding && (
            <div className="site-anchor-links">
              <WebsiteLink href="#features">{t('web.navFeatures')}</WebsiteLink>
              <WebsiteLink href="#security">{t('web.navSecurity')}</WebsiteLink>
              <WebsiteLink href="#apps">{t('web.navApps')}</WebsiteLink>
              <WebsiteLink href="#platforms">{t('web.navPlatforms')}</WebsiteLink>
            </div>
          )}
        </div>
        <nav aria-label={t('web.navigation')}>
          <Select
            aria-label={t('web.language')}
            value={getLanguage()}
            options={LANGUAGE_OPTIONS.map(option => ({
              ...option,
              icon: (
                <img
                  src={`/flags/${option.flag}.svg`}
                  alt=""
                  width={20}
                  height={15}
                  draggable={false}
                />
              ),
            }))}
            onValueChange={value => setLanguage(value as ReturnType<typeof getLanguage>)}
          />
          <WebsiteLink className="btn btn-secondary" href="/app">
            {t(location.pathname === '/download' ? 'web.useWeb' : 'web.open')}
            <ArrowUpRight size={16} aria-hidden="true" />
          </WebsiteLink>
        </nav>
      </header>
      <main id="content" tabIndex={-1}>
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}

function SectionHeader({ id, eyebrow, title, lead }: { id: string; eyebrow: string; title: string; lead: string }) {
  return (
    <div className="site-section-header" data-reveal="">
      <span className="site-section-eyebrow">{t(eyebrow)}</span>
      <h2 id={id}>{t(title)}</h2>
      <p>{t(lead)}</p>
    </div>
  );
}

export function LandingPage() {
  useLocale();
  const ref = useRef<HTMLDivElement>(null);
  useScrollReveal(ref);
  return (
    <div ref={ref} className="site-landing">
      <div className="lp-backdrop" aria-hidden="true">
        <span className="lp-orb is-a" />
        <span className="lp-orb is-b" />
        <span className="lp-orb is-c" />
      </div>

      <section className="site-hero">
        <div className="site-hero-content">
          <div className="site-eyebrow">
            <span className="site-eyebrow-dot" aria-hidden="true" />
            <span>{t('web.heroTag')}</span>
          </div>
          <h1>{t('web.heroTitle')}</h1>
          <p className="site-description">{t('web.heroSubtitle')}</p>
          <div className="site-actions">
            <WebsiteLink className="btn btn-primary" href="/app">
              {t('web.open')}
              <ArrowUpRight size={18} aria-hidden="true" />
            </WebsiteLink>
            <DownloadButton />
          </div>
          <ul className="site-hero-pills" aria-label={t('web.features')}>
            <li className="site-pill tone-sky"><UserCheck size={14} aria-hidden="true" /><span>{t('web.pillNoLogin')}</span></li>
            <li className="site-pill tone-violet"><ShieldCheck size={14} aria-hidden="true" /><span>{t('web.pillE2ee')}</span></li>
            <li className="site-pill tone-emerald"><FolderUp size={14} aria-hidden="true" /><span>{t('web.pillUnlimitedFiles')}</span></li>
            <li className="site-pill tone-amber"><Check size={14} aria-hidden="true" /><span>{t('web.pillFree')}</span></li>
          </ul>
        </div>
        <HeroRoomPreview />
      </section>

      <section className="site-specs" aria-label={t('web.features')}>
        {specs.map((spec, index) => (
          <div key={spec.value} className={`site-spec-item tone-${spec.tone}`} data-reveal="" style={{ '--reveal-order': index } as CSSProperties}>
            <span className="site-spec-metric">{spec.metric}</span>
            <strong>{t(spec.value)}</strong>
          </div>
        ))}
      </section>

      <div id="features" className="site-section lp-features" aria-labelledby="features-heading">
        <SectionHeader id="features-heading" eyebrow="web.featuresEyebrow" title="web.featuresHeading" lead="web.featuresLead" />
        <Showcase
          tone="violet"
          icon={<Monitor size={13} />}
          tag="web.featStreamTag"
          title="web.featStreamTitle"
          points={['web.splitStreamItem1', 'web.splitStreamItem2', 'web.splitStreamItem3']}
        >
          <StreamDemo />
        </Showcase>
        <Showcase
          tone="sky"
          icon={<Gamepad2 size={13} />}
          tag="web.remoteTag"
          title="web.remoteTitle"
          points={['web.remotePoint1', 'web.remotePoint2', 'web.remotePoint3']}
          reverse
        >
          <RemoteDemo />
        </Showcase>
        <Showcase
          tone="rose"
          icon={<Tv size={13} />}
          tag="web.featWatchTag"
          title="web.featWatchTitle"
          points={['web.splitWatchItem1', 'web.splitWatchItem2', 'web.splitWatchItem3']}
        >
          <WatchDemo />
        </Showcase>
        <Showcase
          tone="emerald"
          icon={<FolderUp size={13} />}
          tag="web.featFilesTag"
          title="web.featFilesTitle"
          points={['web.splitFilesItem1', 'web.filesPoint2', 'web.filesPoint3']}
          reverse
        >
          <FilesDemo />
        </Showcase>
        <Showcase
          tone="amber"
          icon={<Crown size={13} />}
          tag="web.playCreateTag"
          title="web.playCreateTitle"
          points={['web.splitGamesItem1', 'web.splitFilesItem2', 'web.splitFilesItem3']}
        >
          <PlayCreateDemo />
        </Showcase>
      </div>

      <section id="security" className="site-section lp-security" aria-labelledby="security-heading">
        <SectionHeader id="security-heading" eyebrow="web.archEyebrow" title="web.archHeading" lead="web.archLead" />
        <div data-reveal="">
          <P2PJourney />
        </div>
      </section>

      <section id="apps" className="site-section" aria-labelledby="apps-heading">
        <SectionHeader id="apps-heading" eyebrow="web.appsEyebrow" title="web.appsHeading" lead="web.appsLead" />
        <div data-reveal="">
          <AppDock />
        </div>
      </section>

      <section id="platforms" className="site-section" aria-labelledby="platforms-heading">
        <SectionHeader id="platforms-heading" eyebrow="web.platformsEyebrow" title="web.platformsHeading" lead="web.platformsLead" />
        <div className="site-platforms-grid">
          <article className="site-platform-card is-featured" data-reveal="">
            <div className="site-platform-head">
              <span className="site-platform-tag"><Monitor size={14} aria-hidden="true" />{t('web.platformDesktopTag')}</span>
              <h3>{t('web.platformDesktopTitle')}</h3>
              <p>{t('web.platformDesktopDesc')}</p>
            </div>
            <ul className="site-platform-list is-columns">
              {platformItems.desktop.map(item => <li key={item}><Check size={16} aria-hidden="true" /><span>{t(item)}</span></li>)}
            </ul>
            <div className="site-platform-actions">
              <DownloadButton variant="primary" />
            </div>
          </article>
          <article className="site-platform-card" data-reveal="" style={{ '--reveal-order': 1 } as CSSProperties}>
            <div className="site-platform-head">
              <span className="site-platform-tag"><Globe size={14} aria-hidden="true" />{t('web.platformWebTag')}</span>
              <h3>{t('web.platformWebTitle')}</h3>
              <p>{t('web.platformWebDesc')}</p>
            </div>
            <ul className="site-platform-list">
              {platformItems.web.map(item => <li key={item}><Check size={16} aria-hidden="true" /><span>{t(item)}</span></li>)}
            </ul>
            <div className="site-platform-actions">
              <WebsiteLink className="btn btn-secondary" href="/app">
                {t('web.open')}
                <ArrowUpRight size={16} aria-hidden="true" />
              </WebsiteLink>
            </div>
          </article>
        </div>
      </section>

      <section className="site-cta" aria-labelledby="cta-heading" data-reveal="">
        <div className="site-cta-copy">
          <h2 id="cta-heading">{t('web.ctaHeading')}</h2>
          <p>{t('web.ctaText')}</p>
        </div>
        <div className="site-cta-actions">
          <WebsiteLink className="btn btn-primary" href="/app">
            {t('web.open')}
            <ArrowUpRight size={18} aria-hidden="true" />
          </WebsiteLink>
          <DownloadButton />
        </div>
      </section>
    </div>
  );
}
