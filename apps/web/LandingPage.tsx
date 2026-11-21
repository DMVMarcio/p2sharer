import { Outlet, useLocation } from 'react-router';
import { WebsiteLink } from '../../src/components/common/WebsiteLink';
import { DownloadButton } from '../../src/components/common/DownloadButton';
import { SiteFooter } from './SiteFooter';
import {
  ArrowUpRight,
  Check,
  Code2,
  Crown,
  FileText,
  FolderUp,
  Gamepad2,
  Globe,
  KeyRound,
  Lock,
  MessageSquare,
  Monitor,
  Network,
  Palette,
  Pencil,
  Play,
  Radio,
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

export { DownloadsPage } from './DownloadsPage';

const detailedFeatures = [
  {
    icon: Monitor,
    tag: 'web.featStreamTag',
    title: 'web.featStreamTitle',
    description: 'web.featStreamDesc',
  },
  {
    icon: Tv,
    tag: 'web.featWatchTag',
    title: 'web.featWatchTitle',
    description: 'web.featWatchDesc',
  },
  {
    icon: FolderUp,
    tag: 'web.featFilesTag',
    title: 'web.featFilesTitle',
    description: 'web.featFilesDesc',
  },
  {
    icon: Gamepad2,
    tag: 'web.featGamesTag',
    title: 'web.featGamesTitle',
    description: 'web.featGamesDesc',
  },
  {
    icon: ShieldCheck,
    tag: 'web.featSecurityTag',
    title: 'web.featSecurityTitle',
    description: 'web.featSecurityDesc',
  },
  {
    icon: UserCheck,
    tag: 'web.featNoLoginTag',
    title: 'web.featNoLoginTitle',
    description: 'web.featNoLoginDesc',
  },
  {
    icon: Pencil,
    tag: 'web.featCollabTag',
    title: 'web.featCollabTitle',
    description: 'web.featCollabDesc',
  },
  {
    icon: Network,
    tag: 'web.featNetworkTag',
    title: 'web.featNetworkTitle',
    description: 'web.featNetworkDesc',
  },
  {
    icon: Code2,
    tag: 'web.featFreeTag',
    title: 'web.featFreeTitle',
    description: 'web.featFreeDesc',
  },
] as const;

const roomApps = [
  {
    icon: Play,
    title: 'web.appYoutubeTitle',
    description: 'web.appYoutubeDesc',
    badge: 'web.appBadgeAll',
  },
  {
    icon: Tv,
    title: 'web.appTwitchTitle',
    description: 'web.appTwitchDesc',
    badge: 'web.appBadgeAll',
  },
  {
    icon: Crown,
    title: 'web.appGamesTitle',
    description: 'web.appGamesDesc',
    badge: 'web.appBadgeAll',
  },
  {
    icon: Palette,
    title: 'web.appWhiteboardTitle',
    description: 'web.appWhiteboardDesc',
    badge: 'web.appBadgeAll',
  },
  {
    icon: FileText,
    title: 'web.appNotepadTitle',
    description: 'web.appNotepadDesc',
    badge: 'web.appBadgeAll',
  },
  {
    icon: MessageSquare,
    title: 'web.appChatTitle',
    description: 'web.appChatDesc',
    badge: 'web.appBadgeAll',
  },
  {
    icon: Globe,
    title: 'web.appBrowserTitle',
    description: 'web.appBrowserDesc',
    badge: 'web.appBadgeDesktopHost',
  },
  {
    icon: Network,
    title: 'web.appTunnelsTitle',
    description: 'web.appTunnelsDesc',
    badge: 'web.appBadgeDesktop',
  },
] as const;

const architectureSteps = [
  {
    step: '01',
    icon: KeyRound,
    title: 'web.step1Title',
    description: 'web.step1Desc',
  },
  {
    step: '02',
    icon: Radio,
    title: 'web.step2Title',
    description: 'web.step2Desc',
  },
  {
    step: '03',
    icon: Lock,
    title: 'web.step3Title',
    description: 'web.step3Desc',
  },
] as const;

const specs = [
  {
    metric: '4K / 120 FPS',
    value: 'web.specStreamValue',
    description: 'web.specStreamDesc',
  },
  {
    metric: '∞ P2P',
    value: 'web.specFilesValue',
    description: 'web.specFilesDesc',
  },
  {
    metric: 'DTLS-SRTP',
    value: 'web.specSecurityValue',
    description: 'web.specSecurityDesc',
  },
  {
    metric: '$0 • MIT',
    value: 'web.specCostValue',
    description: 'web.specCostDesc',
  },
] as const;

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
              <WebsiteLink href="#apps">{t('web.navApps')}</WebsiteLink>
              <WebsiteLink href="#security">{t('web.navSecurity')}</WebsiteLink>
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

export function LandingPage() {
  useLocale();
  return (
    <div className="site-landing">
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
            <li className="site-pill">
              <UserCheck size={14} aria-hidden="true" />
              <span>{t('web.pillNoLogin')}</span>
            </li>
            <li className="site-pill">
              <ShieldCheck size={14} aria-hidden="true" />
              <span>{t('web.pillE2ee')}</span>
            </li>
            <li className="site-pill">
              <FolderUp size={14} aria-hidden="true" />
              <span>{t('web.pillUnlimitedFiles')}</span>
            </li>
            <li className="site-pill">
              <Check size={14} aria-hidden="true" />
              <span>{t('web.pillFree')}</span>
            </li>
          </ul>
        </div>

        <div className="site-hero-preview" aria-hidden="true">
          <div className="site-preview-window">
            <div className="site-preview-topbar">
              <div className="site-preview-status">
                <span className="site-preview-dot" />
                <span>{t('web.previewRoomBadge')}</span>
              </div>
              <div className="site-preview-badges">
                <span className="site-mono-tag">Ed25519</span>
                <span className="site-mono-tag">WebRTC</span>
              </div>
            </div>

            <div className="site-preview-body">
              <div className="site-preview-stage">
                <div className="site-preview-card-head">
                  <div className="site-preview-card-title">
                    <Monitor size={15} />
                    <span>{t('web.previewStreamTitle')}</span>
                  </div>
                  <span className="site-mono-tag is-accent">4K • 120 FPS</span>
                </div>
                <div className="site-preview-viewport">
                  <div className="site-preview-viewport-grid" />
                  <div className="site-preview-metrics">
                    <span>3840 × 2160</span>
                    <span>50 Mbps</span>
                    <span>NVENC H.264</span>
                    <span>WASAPI</span>
                  </div>
                </div>
              </div>

              <div className="site-preview-row">
                <div className="site-preview-subcard">
                  <div className="site-preview-card-title">
                    <Tv size={15} />
                    <strong>{t('web.previewWatchTitle')}</strong>
                  </div>
                  <p>{t('web.previewWatchStatus')}</p>
                  <div className="site-preview-tags">
                    <span className="site-mono-tag">YouTube</span>
                    <span className="site-mono-tag">Twitch</span>
                  </div>
                </div>

                <div className="site-preview-subcard">
                  <div className="site-preview-card-title">
                    <FolderUp size={15} />
                    <strong>{t('web.previewFileTitle')}</strong>
                  </div>
                  <p>{t('web.previewFileMeta')}</p>
                  <div className="site-preview-transfer">
                    <div className="site-preview-transfer-bar">
                      <span />
                    </div>
                    <span className="site-mono-tag">∞ GB • SHA-256</span>
                  </div>
                </div>
              </div>

              <div className="site-preview-apps-bar">
                <span className="site-preview-apps-label">{t('web.previewAppsTitle')}</span>
                <div className="site-preview-tags">
                  <span className="site-mono-tag">{t('chess.title')}</span>
                  <span className="site-mono-tag">{t('checkers.title')}</span>
                  <span className="site-mono-tag">{t('tictactoe.title')}</span>
                  <span className="site-mono-tag">{t('whiteboard.title')}</span>
                  <span className="site-mono-tag">{t('tunnels.title')}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="site-specs" aria-label={t('web.features')}>
        {specs.map(spec => (
          <div key={spec.value} className="site-spec-item">
            <span className="site-spec-metric">{spec.metric}</span>
            <strong>{t(spec.value)}</strong>
            <p>{t(spec.description)}</p>
          </div>
        ))}
      </section>

      <section id="features" className="site-section" aria-labelledby="features-heading">
        <div className="site-section-header">
          <span className="site-section-eyebrow">{t('web.featuresEyebrow')}</span>
          <h2 id="features-heading">{t('web.featuresHeading')}</h2>
          <p>{t('web.featuresLead')}</p>
        </div>
        <div className="site-features-grid">
          {detailedFeatures.map(({ icon: Icon, tag, title, description }) => (
            <article key={title} className="site-feature-card">
              <div className="site-feature-card-top">
                <div className="site-feature-icon-box">
                  <Icon size={20} aria-hidden="true" />
                </div>
                <span className="site-mono-tag">{t(tag)}</span>
              </div>
              <h3>{t(title)}</h3>
              <p>{t(description)}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="apps" className="site-section" aria-labelledby="apps-heading">
        <div className="site-section-header">
          <span className="site-section-eyebrow">{t('web.appsEyebrow')}</span>
          <h2 id="apps-heading">{t('web.appsHeading')}</h2>
          <p>{t('web.appsLead')}</p>
        </div>
        <div className="site-apps-grid">
          {roomApps.map(({ icon: Icon, title, description, badge }) => (
            <article key={title} className="site-app-card">
              <div className="site-app-card-head">
                <div className="site-app-icon">
                  <Icon size={18} aria-hidden="true" />
                </div>
                <span className="site-mono-tag">{t(badge)}</span>
              </div>
              <h3>{t(title)}</h3>
              <p>{t(description)}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="security" className="site-section" aria-labelledby="security-heading">
        <div className="site-section-header">
          <span className="site-section-eyebrow">{t('web.archEyebrow')}</span>
          <h2 id="security-heading">{t('web.archHeading')}</h2>
          <p>{t('web.archLead')}</p>
        </div>
        <div className="site-steps-grid">
          {architectureSteps.map(({ step, icon: Icon, title, description }) => (
            <article key={step} className="site-step-card">
              <div className="site-step-top">
                <span className="site-step-number">{step}</span>
                <Icon size={18} className="site-step-icon" aria-hidden="true" />
              </div>
              <h3>{t(title)}</h3>
              <p>{t(description)}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="platforms" className="site-section" aria-labelledby="platforms-heading">
        <div className="site-section-header">
          <span className="site-section-eyebrow">{t('web.platformsEyebrow')}</span>
          <h2 id="platforms-heading">{t('web.platformsHeading')}</h2>
          <p>{t('web.platformsLead')}</p>
        </div>
        <div className="site-platforms-grid">
          <article className="site-platform-card">
            <div className="site-platform-head">
              <span className="site-mono-tag">{t('web.platformWebTag')}</span>
              <h3>{t('web.platformWebTitle')}</h3>
              <p>{t('web.platformWebDesc')}</p>
            </div>
            <ul className="site-platform-list">
              <li>
                <Check size={16} aria-hidden="true" />
                <span>{t('web.platformWebItem1')}</span>
              </li>
              <li>
                <Check size={16} aria-hidden="true" />
                <span>{t('web.platformWebItem2')}</span>
              </li>
              <li>
                <Check size={16} aria-hidden="true" />
                <span>{t('web.platformWebItem3')}</span>
              </li>
              <li>
                <Check size={16} aria-hidden="true" />
                <span>{t('web.platformWebItem4')}</span>
              </li>
            </ul>
            <div className="site-platform-actions">
              <WebsiteLink className="btn btn-secondary" href="/app">
                {t('web.open')}
                <ArrowUpRight size={16} aria-hidden="true" />
              </WebsiteLink>
            </div>
          </article>

          <article className="site-platform-card is-featured">
            <div className="site-platform-head">
              <span className="site-mono-tag is-accent">{t('web.platformDesktopTag')}</span>
              <h3>{t('web.platformDesktopTitle')}</h3>
              <p>{t('web.platformDesktopDesc')}</p>
            </div>
            <ul className="site-platform-list">
              <li>
                <Check size={16} aria-hidden="true" />
                <span>{t('web.platformDesktopItem1')}</span>
              </li>
              <li>
                <Check size={16} aria-hidden="true" />
                <span>{t('web.platformDesktopItem2')}</span>
              </li>
              <li>
                <Check size={16} aria-hidden="true" />
                <span>{t('web.platformDesktopItem3')}</span>
              </li>
              <li>
                <Check size={16} aria-hidden="true" />
                <span>{t('web.platformDesktopItem4')}</span>
              </li>
            </ul>
            <div className="site-platform-actions">
              <DownloadButton />
            </div>
          </article>
        </div>
      </section>

      <section className="site-cta" aria-labelledby="cta-heading">
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
