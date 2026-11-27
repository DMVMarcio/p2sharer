import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Outlet, useLocation } from 'react-router';
import { WebsiteLink } from '../../src/components/common/WebsiteLink';
import { DownloadButton } from '../../src/components/common/DownloadButton';
import { SiteFooter } from './SiteFooter';
import {
  ArrowUpRight,
  Briefcase,
  Check,
  Crown,
  FolderUp,
  Gamepad2,
  Globe,
  Menu,
  Monitor,
  ShieldCheck,
  Tv,
  UserCheck,
  X,
} from 'lucide-react';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useLocale } from '../../src/hooks/useLocale';
import { t, getLanguage, setLanguage } from '../../src/i18n';
import { LANGUAGE_OPTIONS } from '../../src/i18n/language';
import { Select } from '../../src/components/common/Select';
import logo from '../../src/assets/logo.png';
import { HeroRoomPreview } from './landing/HeroRoomPreview';
import { FilesDemo, MeetingsDemo, PlayCreateDemo, RemoteDemo, Showcase, StreamDemo, WatchDemo, type Tone } from './landing/Showcase';
import { P2PJourney } from './landing/P2PJourney';
import { AppDock } from './landing/AppDock';
import { LandingBackdrop } from './landing/Backdrop';
import { useScrollReveal } from './landing/motion';
import { usePageMetadata } from './pageMetadata';
import './landing/landing.css';

export { DownloadsPage } from './DownloadsPage';

const specs: { metric: string; value: string; description: string; tone: Tone }[] = [
  { metric: '4K / 120 FPS', value: 'web.specStreamValue', description: 'web.specStreamDesc', tone: 'violet' },
  { metric: '∞ P2P', value: 'web.specFilesValue', description: 'web.specFilesDesc', tone: 'emerald' },
  { metric: 'DTLS-SRTP', value: 'web.specSecurityValue', description: 'web.specSecurityDesc', tone: 'sky' },
  { metric: '$0 • MIT', value: 'web.specCostValue', description: 'web.specCostDesc', tone: 'amber' },
];

const platformItems = {
  web: ['web.platformWebItem1', 'web.platformWebItem2', 'web.platformWebItem3', 'web.platformWebItem4'],
  desktop: ['web.platformDesktopItem1', 'web.platformDesktopItem2', 'web.platformDesktopItem3', 'web.platformDesktopItem4'],
} as const;

/** Closes the compact header menu on navigation, Escape and outside presses. */
function useHeaderMenu(pathname: string, hash: string) {
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setOpen(false), [pathname, hash]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // The language listbox is portaled outside the header.
      if (target && (headerRef.current?.contains(target) || target.closest('.app-select-list'))) return;
      setOpen(false);
    };
    const wide = window.matchMedia('(min-width: 861px)');
    const onWide = () => { if (wide.matches) setOpen(false); };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    wide.addEventListener('change', onWide);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
      wide.removeEventListener('change', onWide);
    };
  }, [open]);

  return { open, setOpen, headerRef, toggleRef };
}

export function SiteLayout() {
  const location = useLocation();
  const isLanding = location.pathname === '/';
  const menu = useHeaderMenu(location.pathname, location.hash);
  useAppTheme();
  useLocale();
  return (
    <div className="site-shell">
      <WebsiteLink className="site-skip" href="#content">
        {t('web.skip')}
      </WebsiteLink>
      <header ref={menu.headerRef} className="site-header" data-menu-open={menu.open || undefined}>
        <WebsiteLink className="site-brand" href="/" aria-label="P2Sharer">
          <img src={logo} alt="" />
          P2Sharer
        </WebsiteLink>
        <button
          ref={menu.toggleRef}
          type="button"
          className="btn-icon-header site-menu-toggle"
          aria-expanded={menu.open}
          aria-controls="site-menu"
          aria-label={t(menu.open ? 'web.menuClose' : 'web.menuOpen')}
          onClick={() => menu.setOpen(current => !current)}
        >
          {menu.open ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
        </button>
        <div id="site-menu" className="site-header-menu">
          {isLanding && (
            <div className="site-anchor-links" onClick={event => { if ((event.target as Element).closest('a')) menu.setOpen(false); }}>
              <WebsiteLink href="#features">{t('web.navFeatures')}</WebsiteLink>
              <WebsiteLink href="#security">{t('web.navSecurity')}</WebsiteLink>
              <WebsiteLink href="#apps">{t('web.navApps')}</WebsiteLink>
              <WebsiteLink href="#platforms">{t('web.navPlatforms')}</WebsiteLink>
            </div>
          )}
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
        </div>
      </header>
      <main id="content" tabIndex={-1}>
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}

/** Wraps each word so the hero title can assemble word by word; spacing stays in the text. */
function splitWords(text: string) {
  let word = 0;
  return text.split(/(\s+)/).map((part, index) => (
    /\s/.test(part) || !part
      ? part
      : <span key={index} className="lp-word" style={{ '--w': word++ } as CSSProperties}>{part}</span>
  ));
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
  usePageMetadata(`P2Sharer — ${t('web.metaTitle')}`, t('web.heroSubtitle'), '/');
  const ref = useRef<HTMLDivElement>(null);
  useScrollReveal(ref);
  return (
    <div ref={ref} className="site-landing">
      <LandingBackdrop />

      <section className="site-hero">
        <div className="site-hero-content">
          <div className="site-eyebrow">
            <span>{t('web.heroTag')}</span>
          </div>
          <h1>{splitWords(t('web.heroTitle'))}</h1>
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
            <p>{t(spec.description)}</p>
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
          id="meetings"
          tone="teal"
          icon={<Briefcase size={13} />}
          tag="web.meetingsTag"
          title="web.meetingsTitle"
          points={['web.meetingsPoint1', 'web.meetingsPoint2', 'web.meetingsPoint3']}
        >
          <MeetingsDemo />
        </Showcase>
        <Showcase
          tone="rose"
          icon={<Tv size={13} />}
          tag="web.featWatchTag"
          title="web.featWatchTitle"
          points={['web.splitWatchItem1', 'web.splitWatchItem2', 'web.splitWatchItem3']}
          reverse
        >
          <WatchDemo />
        </Showcase>
        <Showcase
          tone="emerald"
          icon={<FolderUp size={13} />}
          tag="web.featFilesTag"
          title="web.featFilesTitle"
          points={['web.splitFilesItem1', 'web.filesPoint2', 'web.filesPoint3']}
        >
          <FilesDemo />
        </Showcase>
        <Showcase
          tone="amber"
          icon={<Crown size={13} />}
          tag="web.playCreateTag"
          title="web.playCreateTitle"
          points={['web.splitGamesItem1', 'web.splitFilesItem2', 'web.splitFilesItem3']}
          reverse
        >
          <PlayCreateDemo />
        </Showcase>
      </div>

      <section id="security" className="site-section lp-security" aria-labelledby="security-heading">
        <SectionHeader id="security-heading" eyebrow="web.archEyebrow" title="web.archHeading" lead="web.archLead" />
        <div data-reveal="zoom">
          <P2PJourney />
        </div>
      </section>

      <section id="apps" className="site-section" aria-labelledby="apps-heading">
        <SectionHeader id="apps-heading" eyebrow="web.appsEyebrow" title="web.appsHeading" lead="web.appsLead" />
        <div data-reveal="zoom">
          <AppDock />
        </div>
      </section>

      <section id="platforms" className="site-section" aria-labelledby="platforms-heading">
        <SectionHeader id="platforms-heading" eyebrow="web.platformsEyebrow" title="web.platformsHeading" lead="web.platformsLead" />
        <div className="site-platforms-grid">
          <article className="site-platform-card is-featured" data-reveal="zoom">
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
          <article className="site-platform-card" data-reveal="zoom" style={{ '--reveal-order': 1 } as CSSProperties}>
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

      <section className="site-cta" aria-labelledby="cta-heading" data-reveal="zoom">
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
