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
  MousePointer,
  Network,
  Palette,
  Play,
  Radio,
  ShieldCheck,
  Tv,
  UserCheck,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useLocale } from '../../src/hooks/useLocale';
import { t, getLanguage, setLanguage } from '../../src/i18n';
import { LANGUAGE_OPTIONS } from '../../src/i18n/language';
import { Select } from '../../src/components/common/Select';
import logo from '../../src/assets/logo.png';

export { DownloadsPage } from './DownloadsPage';

const roomApps = [
  {
    kind: 'youtube',
    icon: Play,
    title: 'web.appYoutubeTitle',
    description: 'web.appYoutubeDesc',
    badge: 'web.appBadgeAll',
  },
  {
    kind: 'twitch',
    icon: Tv,
    title: 'web.appTwitchTitle',
    description: 'web.appTwitchDesc',
    badge: 'web.appBadgeAll',
  },
  {
    kind: 'chess',
    icon: Crown,
    title: 'web.appGamesTitle',
    description: 'web.appGamesDesc',
    badge: 'web.appBadgeAll',
  },
  {
    kind: 'whiteboard',
    icon: Palette,
    title: 'web.appWhiteboardTitle',
    description: 'web.appWhiteboardDesc',
    badge: 'web.appBadgeAll',
  },
  {
    kind: 'notepad',
    icon: FileText,
    title: 'web.appNotepadTitle',
    description: 'web.appNotepadDesc',
    badge: 'web.appBadgeAll',
  },
  {
    kind: 'chat',
    icon: MessageSquare,
    title: 'web.appChatTitle',
    description: 'web.appChatDesc',
    badge: 'web.appBadgeAll',
  },
  {
    kind: 'browser',
    icon: Globe,
    title: 'web.appBrowserTitle',
    description: 'web.appBrowserDesc',
    badge: 'web.appBadgeDesktopHost',
  },
  {
    kind: 'tunnels',
    icon: Network,
    title: 'web.appTunnelsTitle',
    description: 'web.appTunnelsDesc',
    badge: 'web.appBadgeDesktop',
  },
] as const;

const coreGuarantees = [
  {
    theme: 'is-violet',
    icon: UserCheck,
    tag: 'web.featNoLoginTag',
    title: 'web.featNoLoginTitle',
    description: 'web.featNoLoginDesc',
  },
  {
    theme: 'is-emerald',
    icon: ShieldCheck,
    tag: 'web.featSecurityTag',
    title: 'web.featSecurityTitle',
    description: 'web.featSecurityDesc',
  },
  {
    theme: 'is-amber',
    icon: Code2,
    tag: 'web.featFreeTag',
    title: 'web.featFreeTitle',
    description: 'web.featFreeDesc',
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
    theme: 'is-cyan',
    metric: '4K / 120 FPS',
    value: 'web.specStreamValue',
    description: 'web.specStreamDesc',
  },
  {
    theme: 'is-emerald',
    metric: '∞ P2P',
    value: 'web.specFilesValue',
    description: 'web.specFilesDesc',
  },
  {
    theme: 'is-violet',
    metric: 'DTLS-SRTP',
    value: 'web.specSecurityValue',
    description: 'web.specSecurityDesc',
  },
  {
    theme: 'is-amber',
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
            <li className="site-pill is-violet">
              <UserCheck size={14} aria-hidden="true" />
              <span>{t('web.pillNoLogin')}</span>
            </li>
            <li className="site-pill is-emerald">
              <ShieldCheck size={14} aria-hidden="true" />
              <span>{t('web.pillE2ee')}</span>
            </li>
            <li className="site-pill is-cyan">
              <FolderUp size={14} aria-hidden="true" />
              <span>{t('web.pillUnlimitedFiles')}</span>
            </li>
            <li className="site-pill is-amber">
              <Check size={14} aria-hidden="true" />
              <span>{t('web.pillFree')}</span>
            </li>
          </ul>
        </div>

        <div className="site-hero-showcase" aria-hidden="true">
          <div className="site-app-mockup">
            <div className="site-app-titlebar">
              <div className="site-app-titlebar-left">
                <img src={logo} alt="" className="site-app-mini-logo" />
                <span className="site-app-room-name">P2P Studio &amp; Lounge</span>
                <span className="site-app-e2ee-pill">
                  <Lock size={11} />
                  DTLS-SRTP
                </span>
              </div>
              <div className="site-app-avatars">
                <span className="site-avatar is-cyan">AL</span>
                <span className="site-avatar is-rose">MK</span>
                <span className="site-avatar is-emerald">RV</span>
                <span className="site-avatar is-amber">JP</span>
              </div>
            </div>

            <div className="site-app-workspace">
              <div className="site-app-stage-grid">
                {/* 1. 4K 120 FPS Stream Tile */}
                <div className="site-mock-tile is-stream-tile">
                  <div className="site-mock-tile-badges">
                    <span className="site-live-dot-badge">
                      <span />
                      4K • 120 FPS
                    </span>
                    <span className="site-glass-badge">NVENC • 50 Mbps</span>
                  </div>
                  <svg className="site-mock-stream-svg" viewBox="0 0 320 170" fill="none">
                    <defs>
                      <linearGradient id="heroSky" x1="0" y1="0" x2="320" y2="170" gradientUnits="userSpaceOnUse">
                        <stop offset="0%" stopColor="#0f172a" />
                        <stop offset="55%" stopColor="#1e1b4b" />
                        <stop offset="100%" stopColor="#092e4c" />
                      </linearGradient>
                      <linearGradient id="heroMountain" x1="160" y1="60" x2="160" y2="170" gradientUnits="userSpaceOnUse">
                        <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.45" />
                        <stop offset="100%" stopColor="#0284c7" stopOpacity="0.08" />
                      </linearGradient>
                    </defs>
                    <rect width="320" height="170" fill="url(#heroSky)" />
                    <circle cx="245" cy="52" r="24" fill="#38bdf8" fillOpacity="0.22" />
                    <circle cx="245" cy="52" r="13" fill="#7dd3fc" fillOpacity="0.45" />
                    <path d="M0 145 L75 82 L145 128 L220 68 L320 135 L320 170 L0 170 Z" fill="url(#heroMountain)" />
                    <path d="M0 155 L110 98 L195 142 L270 92 L320 128 L320 170 L0 170 Z" fill="#0ea5e9" fillOpacity="0.18" />
                    {/* Live Stream Annotation Curve */}
                    <path
                      d="M58 112 C95 62, 165 65, 204 102"
                      stroke="#f43f5e"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeDasharray="4 4"
                    />
                    <circle cx="204" cy="102" r="14" stroke="#22d3ee" strokeWidth="2" fill="#22d3ee" fillOpacity="0.12" />
                  </svg>
                  <div className="site-mock-cursor is-rose" style={{ top: '54%', left: '61%' }}>
                    <MousePointer size={12} />
                    <span>MK</span>
                  </div>
                  <div className="site-mock-tile-footer">
                    <span className="site-audio-wave">
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                    <span>WASAPI Loopback</span>
                  </div>
                </div>

                {/* 2. YouTube & Twitch Watch Party Tile */}
                <div className="site-mock-tile is-watch-tile">
                  <div className="site-mock-tile-badges">
                    <span className="site-brand-pill is-youtube">YouTube</span>
                    <span className="site-brand-pill is-twitch">Twitch</span>
                  </div>
                  <div className="site-mock-watch-center">
                    <div className="site-mock-play-circle">
                      <Play size={18} fill="currentColor" />
                    </div>
                  </div>
                  <div className="site-mock-watch-bar">
                    <div className="site-mock-scrubber">
                      <span style={{ width: '64%' }} />
                    </div>
                    <span className="site-mock-time">24:10 • SYNC</span>
                  </div>
                </div>

                {/* 3. Cozy Wooden Chess Board Tile */}
                <div className="site-mock-tile is-chess-tile">
                  <div className="site-mock-tile-badges">
                    <span className="site-glass-badge">
                      <Crown size={11} />
                      {t('chess.title')}
                    </span>
                  </div>
                  <div className="site-mini-chessboard">
                    {Array.from({ length: 16 }).map((_, idx) => {
                      const row = Math.floor(idx / 4);
                      const col = idx % 4;
                      const isDark = (row + col) % 2 === 1;
                      const piece =
                        idx === 1 ? '♛' : idx === 6 ? '♞' : idx === 9 ? '♖' : idx === 14 ? '♔' : null;
                      return (
                        <div key={idx} className={`site-chess-cell ${isDark ? 'is-dark' : 'is-light'}`}>
                          {piece && <span className={idx < 8 ? 'is-black-piece' : 'is-white-piece'}>{piece}</span>}
                        </div>
                      );
                    })}
                    <svg className="site-chess-arrow" viewBox="0 0 100 100" fill="none">
                      <path
                        d="M38 64 Q38 38 62 38"
                        stroke="#fbbf24"
                        strokeWidth="5"
                        strokeLinecap="round"
                      />
                      <polygon points="62,29 74,38 62,47" fill="#fbbf24" />
                    </svg>
                  </div>
                </div>

                {/* 4. Whiteboard & Collaborative Notes Tile */}
                <div className="site-mock-tile is-whiteboard-tile">
                  <div className="site-mock-tile-badges">
                    <span className="site-glass-badge">
                      <Palette size={11} />
                      {t('whiteboard.title')}
                    </span>
                  </div>
                  <svg className="site-mock-wb-svg" viewBox="0 0 200 120" fill="none">
                    <rect x="22" y="34" width="54" height="42" rx="8" stroke="#2dd4bf" strokeWidth="2.5" fill="#2dd4bf" fillOpacity="0.14" />
                    <circle cx="132" cy="60" r="24" stroke="#fbbf24" strokeWidth="2.5" fill="#fbbf24" fillOpacity="0.14" />
                    <path d="M78 55 C95 55, 92 60, 106 60" stroke="#f8fafc" strokeWidth="2" strokeDasharray="3 3" />
                  </svg>
                  <div className="site-mock-cursor is-emerald" style={{ bottom: '18%', right: '16%' }}>
                    <MousePointer size={12} />
                    <span>RV</span>
                  </div>
                </div>
              </div>

              {/* Right Sidebar: Chat & Unlimited File Transfer */}
              <div className="site-app-sidebar">
                <div className="site-sidebar-chat">
                  <div className="site-chat-line">
                    <span className="site-chat-author is-cyan">AL</span>
                    <span className="site-chat-bubble">4K 120fps stream ready</span>
                  </div>
                  <div className="site-chat-line">
                    <span className="site-chat-author is-rose">MK</span>
                    <span className="site-chat-bubble">YouTube queue synced!</span>
                  </div>
                </div>
                <div className="site-sidebar-transfer">
                  <div className="site-transfer-head">
                    <FolderUp size={13} />
                    <span>build-raw-4k.zip</span>
                  </div>
                  <div className="site-transfer-meta">
                    <span>42.8 GB • P2P</span>
                    <span className="site-sha-tag">SHA-256 ✓</span>
                  </div>
                  <div className="site-transfer-progress">
                    <span style={{ width: '82%' }} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="site-specs" aria-label={t('web.features')}>
        {specs.map(spec => (
          <div key={spec.value} className={`site-spec-item ${spec.theme}`}>
            <span className="site-spec-metric">{spec.metric}</span>
            <strong>{t(spec.value)}</strong>
            <p>{t(spec.description)}</p>
          </div>
        ))}
      </section>

      {/* Alternating Split Sections for Differentiators */}
      <section id="features" className="site-section" aria-labelledby="features-heading">
        <div className="site-section-header">
          <span className="site-section-eyebrow">{t('web.featuresEyebrow')}</span>
          <h2 id="features-heading">{t('web.featuresHeading')}</h2>
          <p>{t('web.featuresLead')}</p>
        </div>

        <div className="site-splits-list">
          {/* Split 1: 4K 120 FPS Streaming & Isolated Audio (Text Left | Visual Right) */}
          <article className="site-split-row is-cyan">
            <div className="site-split-copy">
              <span className="site-color-tag is-cyan">
                <Monitor size={14} aria-hidden="true" />
                {t('web.featStreamTag')}
              </span>
              <h3>{t('web.featStreamTitle')}</h3>
              <p>{t('web.featStreamDesc')}</p>
              <ul className="site-split-highlights">
                <li>
                  <Check size={16} aria-hidden="true" />
                  <span>{t('web.splitStreamItem1')}</span>
                </li>
                <li>
                  <Check size={16} aria-hidden="true" />
                  <span>{t('web.splitStreamItem2')}</span>
                </li>
                <li>
                  <Check size={16} aria-hidden="true" />
                  <span>{t('web.splitStreamItem3')}</span>
                </li>
              </ul>
            </div>

            <div className="site-split-visual is-stream-visual" aria-hidden="true">
              <div className="site-visual-monitor">
                <div className="site-visual-monitor-top">
                  <span className="site-live-dot-badge">
                    <span />
                    3840 × 2160 • 120 FPS
                  </span>
                  <div className="site-visual-hud-pills">
                    <span>50 Mbps</span>
                    <span>NVENC H.264</span>
                    <span>PiP</span>
                  </div>
                </div>
                <div className="site-visual-monitor-canvas">
                  <svg viewBox="0 0 460 220" fill="none" className="site-visual-scene-svg">
                    <defs>
                      <linearGradient id="splitStreamGrad" x1="0" y1="0" x2="460" y2="220" gradientUnits="userSpaceOnUse">
                        <stop offset="0%" stopColor="#071324" />
                        <stop offset="50%" stopColor="#0c2540" />
                        <stop offset="100%" stopColor="#17163b" />
                      </linearGradient>
                    </defs>
                    <rect width="460" height="220" fill="url(#splitStreamGrad)" />
                    <circle cx="360" cy="65" r="42" fill="#06b6d4" fillOpacity="0.18" />
                    <path d="M0 185 L105 95 L205 152 L320 74 L460 165 L460 220 L0 220 Z" fill="#0284c7" fillOpacity="0.24" />
                    <path d="M0 198 L160 120 L270 172 L385 105 L460 150 L460 220 L0 220 Z" fill="#38bdf8" fillOpacity="0.16" />
                    {/* Interactive stream drawing annotation */}
                    <rect x="112" y="54" width="144" height="84" rx="10" stroke="#22d3ee" strokeWidth="2.5" strokeDasharray="6 4" fill="#06b6d4" fillOpacity="0.08" />
                    <path d="M268 95 C302 95, 310 74, 344 72" stroke="#f43f5e" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                  <div className="site-mock-cursor is-cyan" style={{ top: '62%', left: '54%' }}>
                    <MousePointer size={13} />
                    <span>{t('web.visualLivePointer')}</span>
                  </div>
                </div>
                <div className="site-visual-audio-mixer">
                  <div className="site-audio-process is-included">
                    <Volume2 size={15} />
                    <div className="site-audio-process-info">
                      <strong>GameEngine.exe</strong>
                      <span>WASAPI • {t('web.visualAudioIncluded')}</span>
                    </div>
                    <div className="site-audio-bars">
                      <span style={{ height: '55%' }} />
                      <span style={{ height: '95%' }} />
                      <span style={{ height: '70%' }} />
                      <span style={{ height: '85%' }} />
                    </div>
                  </div>
                  <div className="site-audio-process is-muted">
                    <VolumeX size={15} />
                    <div className="site-audio-process-info">
                      <strong>SystemAlerts.exe</strong>
                      <span>{t('web.visualAudioMuted')}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </article>

          {/* Split 2: Synchronized YouTube & Twitch (Visual Left | Text Right) */}
          <article className="site-split-row is-reverse is-crimson">
            <div className="site-split-copy">
              <span className="site-color-tag is-crimson">
                <Tv size={14} aria-hidden="true" />
                {t('web.featWatchTag')}
              </span>
              <h3>{t('web.featWatchTitle')}</h3>
              <p>{t('web.featWatchDesc')}</p>
              <ul className="site-split-highlights">
                <li>
                  <Check size={16} aria-hidden="true" />
                  <span>{t('web.splitWatchItem1')}</span>
                </li>
                <li>
                  <Check size={16} aria-hidden="true" />
                  <span>{t('web.splitWatchItem2')}</span>
                </li>
                <li>
                  <Check size={16} aria-hidden="true" />
                  <span>{t('web.splitWatchItem3')}</span>
                </li>
              </ul>
            </div>

            <div className="site-split-visual is-watch-visual" aria-hidden="true">
              <div className="site-visual-watch-card">
                <div className="site-visual-watch-header">
                  <div className="site-watch-brand-group">
                    <span className="site-brand-pill is-youtube">
                      <Play size={12} fill="currentColor" />
                      YouTube
                    </span>
                    <span className="site-brand-pill is-twitch">
                      <Tv size={12} />
                      Twitch
                    </span>
                  </div>
                  <span className="site-sync-status-pill">{t('web.visualSyncedPeers')}</span>
                </div>

                <div className="site-visual-watch-stage">
                  <div className="site-visual-watch-play">
                    <Play size={26} fill="currentColor" />
                  </div>
                  <div className="site-visual-watch-controls">
                    <span className="site-mono-time">18:42</span>
                    <div className="site-visual-watch-progress">
                      <div className="site-visual-watch-fill" style={{ width: '58%' }} />
                    </div>
                    <span className="site-mono-time">32:15</span>
                  </div>
                </div>

                <div className="site-visual-queue">
                  <div className="site-visual-queue-head">
                    <span>{t('web.visualQueueUpNext')}</span>
                    <span className="site-mono-tag">3 items</span>
                  </div>
                  <div className="site-visual-queue-items">
                    <div className="site-queue-row is-active">
                      <span className="site-queue-thumb is-yt" />
                      <div className="site-queue-text">
                        <strong>4K HDR Nature &amp; Space Documentary</strong>
                        <span>YouTube • 32:15</span>
                      </div>
                    </div>
                    <div className="site-queue-row">
                      <span className="site-queue-thumb is-tw" />
                      <div className="site-queue-text">
                        <strong>Speedrun Marathon Live Channel</strong>
                        <span>Twitch • LIVE</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </article>

          {/* Split 3: Unlimited P2P File Transfers & Collaborative Whiteboard/Notes (Text Left | Visual Right) */}
          <article className="site-split-row is-emerald">
            <div className="site-split-copy">
              <span className="site-color-tag is-emerald">
                <FolderUp size={14} aria-hidden="true" />
                {t('web.featFilesTag')}
              </span>
              <h3>{t('web.splitFilesTitle')}</h3>
              <p>{t('web.splitFilesDesc')}</p>
              <ul className="site-split-highlights">
                <li>
                  <Check size={16} aria-hidden="true" />
                  <span>{t('web.splitFilesItem1')}</span>
                </li>
                <li>
                  <Check size={16} aria-hidden="true" />
                  <span>{t('web.splitFilesItem2')}</span>
                </li>
                <li>
                  <Check size={16} aria-hidden="true" />
                  <span>{t('web.splitFilesItem3')}</span>
                </li>
              </ul>
            </div>

            <div className="site-split-visual is-files-visual" aria-hidden="true">
              <div className="site-visual-files-stack">
                <div className="site-visual-transfer-card">
                  <div className="site-visual-transfer-top">
                    <div className="site-visual-file-badge">
                      <FolderUp size={18} />
                      <div>
                        <strong>production-render-master.tar.zst</strong>
                        <span>64.8 GB • {t('web.visualDirectTransfer')}</span>
                      </div>
                    </div>
                    <span className="site-sha-pill">SHA-256 ✓</span>
                  </div>
                  <div className="site-visual-transfer-track">
                    <span style={{ width: '88%' }} />
                  </div>
                  <div className="site-visual-transfer-stats">
                    <span>Peer A ─── WebRTC DataChannel ───▶ Peer B</span>
                    <span>∞ GB</span>
                  </div>
                </div>

                <div className="site-visual-collab-duo">
                  <div className="site-visual-wb-card">
                    <div className="site-visual-card-mini-head">
                      <Palette size={14} />
                      <strong>{t('whiteboard.title')}</strong>
                      <span>PNG / SVG</span>
                    </div>
                    <svg viewBox="0 0 220 96" fill="none" className="site-visual-wb-canvas">
                      <rect x="16" y="18" width="66" height="52" rx="10" stroke="#2dd4bf" strokeWidth="2.5" fill="#14b8a6" fillOpacity="0.15" />
                      <circle cx="152" cy="46" r="26" stroke="#38bdf8" strokeWidth="2.5" fill="#0ea5e9" fillOpacity="0.15" />
                      <path d="M86 44 C105 44, 105 46, 122 46" stroke="#a7f3d0" strokeWidth="2" strokeDasharray="4 4" />
                    </svg>
                  </div>

                  <div className="site-visual-code-card">
                    <div className="site-visual-card-mini-head">
                      <FileText size={14} />
                      <strong>CRDT Notepad</strong>
                      <span>Yjs • Code</span>
                    </div>
                    <pre className="site-visual-code-snippet">
                      <code>
                        <span className="c-kw">const</span> room = <span className="c-fn">connectP2P</span>({'{'}
                        {'\n'}  e2ee: <span className="c-bool">true</span>,
                        {'\n'}  maxFileSize: <span className="c-num">Infinity</span>
                        {'\n'}{'}'});
                      </code>
                    </pre>
                  </div>
                </div>
              </div>
            </div>
          </article>

          {/* Split 4: Cozy Board Minigames, Shared Browser & Local Networking (Visual Left | Text Right) */}
          <article className="site-split-row is-reverse is-amber">
            <div className="site-split-copy">
              <span className="site-color-tag is-amber">
                <Gamepad2 size={14} aria-hidden="true" />
                {t('web.featGamesTag')}
              </span>
              <h3>{t('web.splitGamesTitle')}</h3>
              <p>{t('web.splitGamesDesc')}</p>
              <ul className="site-split-highlights">
                <li>
                  <Check size={16} aria-hidden="true" />
                  <span>{t('web.splitGamesItem1')}</span>
                </li>
                <li>
                  <Check size={16} aria-hidden="true" />
                  <span>{t('web.splitGamesItem2')}</span>
                </li>
                <li>
                  <Check size={16} aria-hidden="true" />
                  <span>{t('web.splitGamesItem3')}</span>
                </li>
              </ul>
            </div>

            <div className="site-split-visual is-games-visual" aria-hidden="true">
              <div className="site-visual-games-layout">
                <div className="site-visual-board-card">
                  <div className="site-visual-board-header">
                    <div className="site-game-tabs">
                      <span className="is-active">
                        <Crown size={12} />
                        {t('chess.title')}
                      </span>
                      <span>{t('checkers.title')}</span>
                      <span>{t('tictactoe.title')}</span>
                    </div>
                    <span className="site-game-live-tag">{t('web.visualYourTurn')}</span>
                  </div>

                  <div className="site-visual-wood-frame">
                    <div className="site-visual-chess-grid">
                      {Array.from({ length: 16 }).map((_, idx) => {
                        const row = Math.floor(idx / 4);
                        const col = idx % 4;
                        const isDark = (row + col) % 2 === 1;
                        const piece =
                          idx === 0
                            ? '♜'
                            : idx === 2
                              ? '♚'
                              : idx === 5
                                ? '♟'
                                : idx === 7
                                  ? '♛'
                                  : idx === 8
                                    ? '♘'
                                    : idx === 10
                                      ? '♙'
                                      : idx === 13
                                        ? '♕'
                                        : idx === 15
                                          ? '♔'
                                          : null;
                        return (
                          <div key={idx} className={`site-wood-square ${isDark ? 'is-oak' : 'is-maple'}`}>
                            {piece && <span className={idx < 8 ? 'is-dark-fig' : 'is-light-fig'}>{piece}</span>}
                          </div>
                        );
                      })}
                      <svg className="site-board-plan-svg" viewBox="0 0 160 160" fill="none">
                        <path
                          d="M22 102 Q22 60 60 60"
                          stroke="#fbbf24"
                          strokeWidth="6"
                          strokeLinecap="round"
                        />
                        <polygon points="58,48 74,60 58,72" fill="#fbbf24" />
                      </svg>
                    </div>
                  </div>
                </div>

                <div className="site-visual-net-stack">
                  <div className="site-visual-net-card is-browser-banner">
                    <div className="site-visual-net-icon">
                      <Globe size={18} />
                    </div>
                    <div>
                      <strong>{t('web.appBrowserTitle')}</strong>
                      <span>Multi-Tab WebView • Shared Audio &amp; Input</span>
                    </div>
                  </div>

                  <div className="site-visual-net-card is-tunnel-banner">
                    <div className="site-visual-net-icon">
                      <Network size={18} />
                    </div>
                    <div>
                      <strong>{t('web.appTunnelsTitle')}</strong>
                      <span>TCP / UDP Ports ⇄ Virtual LAN (Wintun)</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </article>
        </div>
      </section>

      {/* Authentic Colorful Room Apps Banner Showcase */}
      <section id="apps" className="site-section" aria-labelledby="apps-heading">
        <div className="site-section-header">
          <span className="site-section-eyebrow">{t('web.appsEyebrow')}</span>
          <h2 id="apps-heading">{t('web.appsHeading')}</h2>
          <p>{t('web.appsLead')}</p>
        </div>
        <div className="site-apps-showcase-grid">
          {roomApps.map(({ kind, icon: Icon, title, description, badge }) => (
            <article key={title} className="site-app-showcase-card">
              <div className={`site-app-banner is-${kind}`} aria-hidden="true">
                <div className="site-app-banner-rings" />
                <div className="site-app-banner-icon">
                  <Icon size={28} />
                </div>
                <span className="site-app-banner-badge">{t(badge)}</span>
              </div>
              <div className="site-app-showcase-body">
                <h3>{t(title)}</h3>
                <p>{t(description)}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* Privacy, Zero-Login, E2EE & Architecture Section */}
      <section id="security" className="site-section" aria-labelledby="security-heading">
        <div className="site-section-header">
          <span className="site-section-eyebrow">{t('web.archEyebrow')}</span>
          <h2 id="security-heading">{t('web.archHeading')}</h2>
          <p>{t('web.archLead')}</p>
        </div>

        <div className="site-guarantees-grid">
          {coreGuarantees.map(({ theme, icon: Icon, tag, title, description }) => (
            <article key={title} className={`site-guarantee-card ${theme}`}>
              <div className="site-guarantee-top">
                <div className="site-guarantee-icon">
                  <Icon size={20} aria-hidden="true" />
                </div>
                <span className="site-mono-tag">{t(tag)}</span>
              </div>
              <h3>{t(title)}</h3>
              <p>{t(description)}</p>
            </article>
          ))}
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
