import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Check,
  CloudOff,
  FileArchive,
  Gamepad2,
  Globe,
  Laptop,
  Monitor,
  Music,
  Pause,
  Play,
  ShieldCheck,
  Swords,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { t } from '../../../src/i18n';
import { GameScene, LevelMeter, LiveCursor, MiniChessBoard, PEERS, PeerAvatar, WhiteboardSketch } from './scenes';
import { useInView } from './motion';

export type Tone = 'violet' | 'rose' | 'emerald' | 'amber' | 'sky' | 'pink';

interface ShowcaseProps {
  id?: string;
  tone: Tone;
  icon: ReactNode;
  tag: string;
  title: string;
  description: string;
  points: readonly string[];
  hint?: string;
  reverse?: boolean;
  children: ReactNode;
}

/** Split feature section: an illustrative demo on one side and its explanation on the other. */
export function Showcase({ id, tone, icon, tag, title, description, points, hint, reverse, children }: ShowcaseProps) {
  const ref = useRef<HTMLElement>(null);
  const active = useInView(ref);
  return (
    <section
      ref={ref}
      id={id}
      className={`lp-showcase tone-${tone}${reverse ? ' is-reverse' : ''}`}
      data-active={active || undefined}
      aria-labelledby={`${tone}-showcase-title`}
    >
      <div className="lp-showcase-copy" data-reveal="">
        <span className="lp-tag"><span className="lp-tag-icon">{icon}</span>{t(tag)}</span>
        <h2 id={`${tone}-showcase-title`}>{t(title)}</h2>
        <p>{t(description)}</p>
        <ul>
          {points.map(point => (
            <li key={point}><span className="lp-check"><Check size={13} aria-hidden="true" /></span>{t(point)}</li>
          ))}
        </ul>
      </div>
      <div className="lp-showcase-visual" data-reveal="" style={{ '--reveal-order': 1 } as CSSProperties}>
        <div className="lp-showcase-glow" aria-hidden="true" />
        {children}
        {hint && <p className="lp-hint">{t(hint)}</p>}
      </div>
    </section>
  );
}

const AUDIO_SOURCES = [
  { id: 'game', label: 'game.exe', icon: Gamepad2 },
  { id: 'music', label: 'music.exe', icon: Music },
  { id: 'browser', label: 'browser.exe', icon: Globe },
] as const;

/** Screen sharing with per-application audio the visitor can toggle. */
export function StreamDemo() {
  const [muted, setMuted] = useState<Record<string, boolean>>({ browser: true });
  return (
    <div className="lp-demo lp-stream-demo">
      <div className="lp-screen is-large" aria-hidden="true">
        <GameScene />
        <svg className="lp-annotation" viewBox="0 0 100 60" preserveAspectRatio="none">
          <ellipse cx="50" cy="44" rx="12" ry="10" />
        </svg>
        <LiveCursor peer={PEERS[0]} className="lp-screen-cursor" />
        <div className="lp-screen-hud">
          <span className="lp-chip is-glass is-mono">3840 × 2160</span>
          <span className="lp-chip is-glass is-mono">120 FPS</span>
          <span className="lp-chip is-glass is-mono">NVENC</span>
        </div>
        <span className="lp-chip is-glass lp-screen-label">{t('web.visualLivePointer')}</span>
      </div>
      <div className="lp-mixer">
        {AUDIO_SOURCES.map(({ id, label, icon: Icon }) => {
          const off = Boolean(muted[id]);
          return (
            <button
              key={id}
              type="button"
              className={`lp-mixer-row${off ? ' is-off' : ''}`}
              aria-pressed={!off}
              aria-label={`${t(off ? 'browser.unmute' : 'browser.mute')} ${label}`}
              onClick={() => setMuted(current => ({ ...current, [id]: !current[id] }))}
            >
              <span className="lp-mixer-icon" aria-hidden="true"><Icon size={15} /></span>
              <span className="lp-mixer-name" aria-hidden="true">
                <strong>{label}</strong>
                <small>{t(off ? 'web.visualAudioMuted' : 'web.visualAudioIncluded')}</small>
              </span>
              <LevelMeter bars={7} muted={off} />
              <span className="lp-mixer-toggle" aria-hidden="true">{off ? <VolumeX size={15} /> : <Volume2 size={15} />}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Synchronized playback: one pause control freezes every participant's player. */
export function WatchDemo() {
  const [paused, setPaused] = useState(false);
  return (
    <div className={`lp-demo lp-watch-demo${paused ? ' is-paused' : ''}`}>
      <div className="lp-player">
        <div className="lp-player-art" aria-hidden="true">
          <span className="lp-player-shape is-a" />
          <span className="lp-player-shape is-b" />
          <span className="lp-player-shape is-c" />
        </div>
        <button
          type="button"
          className="lp-player-button"
          aria-pressed={paused}
          aria-label={t(paused ? 'message.ca0709c34209' : 'message.c1301275ce3f')}
          onClick={() => setPaused(value => !value)}
        >
          {paused ? <Play size={22} aria-hidden="true" /> : <Pause size={22} aria-hidden="true" />}
        </button>
        <div className="lp-player-progress" aria-hidden="true"><i /></div>
      </div>
      <div className="lp-watch-side" aria-hidden="true">
        <div className="lp-watch-card">
          <span className="lp-watch-label">{t('web.visualSyncedPeers')}</span>
          {PEERS.slice(0, 3).map(peer => (
            <div key={peer.name} className="lp-sync-row">
              <PeerAvatar peer={peer} size={22} />
              <span className="lp-sync-bar" style={{ '--peer': peer.color } as CSSProperties}><i /></span>
            </div>
          ))}
        </div>
        <div className="lp-watch-card">
          <span className="lp-watch-label">{t('web.visualQueueUpNext')}</span>
          {[0, 1, 2].map(index => (
            <div key={index} className="lp-queue-row" style={{ '--i': index } as CSSProperties}>
              <span className="lp-queue-thumb" />
              <span className="lp-skeleton-lines"><i /><i /></span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Direct device-to-device transfer with packets crossing between peers. */
export function FilesDemo() {
  return (
    <div className="lp-demo lp-files-demo" aria-hidden="true">
      <div className="lp-cloud-off"><CloudOff size={15} />{t('web.visualDirectTransfer')}</div>
      <div className="lp-transfer-lane">
        <div className="lp-device">
          <Laptop size={26} />
          <PeerAvatar peer={PEERS[3]} size={24} />
          <span>{t('browser.you')}</span>
        </div>
        <div className="lp-beam">
          {Array.from({ length: 6 }, (_, index) => <i key={index} style={{ '--i': index } as CSSProperties} />)}
        </div>
        <div className="lp-device">
          <Monitor size={26} />
          <PeerAvatar peer={PEERS[0]} size={24} />
          <span>Ana</span>
        </div>
      </div>
      <div className="lp-transfer-card">
        <span className="lp-transfer-icon"><FileArchive size={20} /></span>
        <div className="lp-transfer-meta">
          <strong>holiday-photos-raw.zip</strong>
          <small>48.6 GB</small>
          <span className="lp-transfer-bar"><i /></span>
        </div>
        <span className="lp-transfer-percent" />
      </div>
      <div className="lp-verified"><ShieldCheck size={14} />SHA-256 ✓</div>
    </div>
  );
}

/** Games and whiteboard side by side, both updated live. */
export function PlayCreateDemo() {
  return (
    <div className="lp-demo lp-play-demo" aria-hidden="true">
      <div className="lp-play-card">
        <div className="lp-play-head">
          <span>{t('chess.title')}</span>
          <span className="lp-play-turn"><PeerAvatar peer={PEERS[1]} size={18} /> <Swords size={12} /> <PeerAvatar peer={PEERS[2]} size={18} /></span>
        </div>
        <MiniChessBoard />
      </div>
      <div className="lp-play-card">
        <div className="lp-play-head"><span>{t('whiteboard.title')}</span></div>
        <WhiteboardSketch />
      </div>
    </div>
  );
}
