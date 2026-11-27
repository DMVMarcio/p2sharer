import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Check,
  CloudOff,
  FileArchive,
  FileText,
  Gamepad2,
  Keyboard,
  Mic,
  MicOff,
  MousePointer2,
  Globe,
  Headphones,
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
import { LevelMeter, LiveCursor, MiniChessBoard, PEERS, PeerAvatar, WhiteboardSketch } from './scenes';
import { DrawingPointer, ShooterScene, StudioScene } from './screenScenes';
import { useInView } from './motion';

export type Tone = 'violet' | 'rose' | 'emerald' | 'amber' | 'sky' | 'pink' | 'teal';

interface ShowcaseProps {
  id?: string;
  tone: Tone;
  icon: ReactNode;
  tag: string;
  title: string;
  points: readonly string[];
  reverse?: boolean;
  children: ReactNode;
}

/** Split feature section: an illustrative demo on one side and its explanation on the other. */
export function Showcase({ id, tone, icon, tag, title, points, reverse, children }: ShowcaseProps) {
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
        <ul>
          {points.map(point => (
            <li key={point}><span className="lp-check"><Check size={13} aria-hidden="true" /></span>{t(point)}</li>
          ))}
        </ul>
      </div>
      <div className="lp-showcase-visual" data-reveal="" style={{ '--reveal-order': 1 } as CSSProperties}>
        <div className="lp-showcase-glow" aria-hidden="true" />
        {children}
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
        <StudioScene />
        <DrawingPointer peer={PEERS[0]} />
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
        <StereoField silent={AUDIO_SOURCES.every(source => muted[source.id])} />
      </div>
    </div>
  );
}

/** Master output showing that left and right channels reach each ear separately. */
function StereoField({ silent }: { silent: boolean }) {
  return (
    <div className={`lp-stereo${silent ? ' is-off' : ''}`}>
      <span className="lp-mixer-icon" aria-hidden="true"><Headphones size={15} /></span>
      <span className="lp-mixer-name">
        <strong>{t('web.visualStereoTitle')}</strong>
        <small>{t('web.visualStereoHint')}</small>
      </span>
      <span className="lp-stereo-field" aria-hidden="true">
        <span className="lp-stereo-channel"><b>L</b><i /></span>
        <span className="lp-stereo-channel is-right"><b>R</b><i /></span>
      </span>
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

const FACE_BUTTONS = [
  { id: 'y', label: 'Y', color: '#facc15' },
  { id: 'x', label: 'X', color: '#38bdf8' },
  { id: 'b', label: 'B', color: '#f87171' },
  { id: 'a', label: 'A', color: '#4ade80' },
] as const;

const REMAPS = [['LB', 'RB'], ['Y', 'X'], ['RT', 'A']] as const;

/** Remote control with virtual gamepads: the face buttons fire inside the shared game. */
export function RemoteDemo() {
  const [shots, setShots] = useState<{ id: number; color: string }[]>([]);
  const [pressed, setPressed] = useState<string | null>(null);
  const counter = useRef(0);

  useEffect(() => {
    if (!pressed) return;
    const timer = window.setTimeout(() => setPressed(null), 180);
    return () => window.clearTimeout(timer);
  }, [pressed]);

  const press = (id: string, color: string) => {
    counter.current += 1;
    const shot = { id: counter.current, color };
    setPressed(id);
    setShots(current => [...current.slice(-4), shot]);
  };

  return (
    <div className="lp-demo lp-remote-demo">
      <div className="lp-screen is-large" aria-hidden="true">
        <ShooterScene />
        {shots.map(shot => (
          <span
            key={shot.id}
            className="lp-shot"
            style={{ '--shot': shot.color } as CSSProperties}
            onAnimationEnd={() => setShots(current => current.filter(item => item.id !== shot.id))}
          />
        ))}
        <div className="lp-remote-hud">
          {[PEERS[1], PEERS[2]].map((peer, index) => (
            <span key={peer.name} className={`lp-remote-player${index === 0 && pressed ? ' is-input' : ''}`}>
              <PeerAvatar peer={peer} size={20} />
              <Gamepad2 size={12} />
              P{index + 1}
            </span>
          ))}
          <span className="lp-remote-player is-idle"><PeerAvatar peer={PEERS[0]} size={20} /><MousePointer2 size={12} /><Keyboard size={12} /></span>
        </div>
        <span className="lp-chip is-glass is-mono lp-screen-label">Xbox 360 × 2</span>
      </div>
      <div className="lp-remote-panel">
        <div className="lp-pad">
          <span className="lp-pad-stick is-left" aria-hidden="true"><i /></span>
          <span className="lp-pad-dpad" aria-hidden="true"><i /><i /></span>
          <span className="lp-pad-stick is-right" aria-hidden="true"><i /></span>
          <div className="lp-pad-face" role="group" aria-label={t('remoteControl.gamepadPermission')}>
            {FACE_BUTTONS.map(button => (
              <button
                key={button.id}
                type="button"
                className={`lp-pad-button is-${button.id}${pressed === button.id ? ' is-pressed' : ''}`}
                style={{ '--btn': button.color } as CSSProperties}
                onClick={() => press(button.id, button.color)}
              >
                {button.label}
              </button>
            ))}
          </div>
        </div>
        <div className="lp-remote-settings" aria-hidden="true">
          <div className="lp-deadzone">
            <span className="lp-remote-label">{t('inputBindings.deadzoneLabel')}</span>
            <div className="lp-deadzone-body">
              <svg viewBox="0 0 64 64">
                <circle className="lp-deadzone-outer" cx="32" cy="32" r="29" />
                <circle className="lp-deadzone-inner" cx="32" cy="32" r="9" />
                <circle className="lp-deadzone-dot" cx="32" cy="32" r="3.6" />
              </svg>
              <strong>12%</strong>
            </div>
          </div>
          <div className="lp-remap">
            <span className="lp-remote-label">{t('web.remoteRemap')}</span>
            {REMAPS.map(([from, to]) => (
              <span key={from} className="lp-remap-row"><b>{from}</b><i>→</i><b>{to}</b></span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Browser-friendly meeting room: shared presentation, interactive mic, chat, and direct file drop. */
export function MeetingsDemo() {
  const [micMuted, setMicMuted] = useState(false);
  return (
    <div className="lp-demo lp-meetings-demo">
      <div className="lp-meeting-stage" aria-hidden="true">
        <div className="lp-meeting-bar">
          <span className="lp-meeting-dots"><i /><i /><i /></span>
          <span className="lp-meeting-url">p2sharer.com/app</span>
          <span className="lp-chip is-glass"><Globe size={11} />{t('web.meetingsVisualBrowser')}</span>
        </div>
        <div className="lp-meeting-slide">
          <div className="lp-meeting-slide-head">
            <strong>{t('web.meetingsVisualSlide')}</strong>
            <span className="lp-meeting-live">LIVE</span>
          </div>
          <div className="lp-meeting-slide-body">
            <div className="lp-meeting-chart">
              {[42, 68, 54, 86, 74, 96].map((height, index) => (
                <span key={index} style={{ '--h': `${height}%`, '--i': index } as CSSProperties} />
              ))}
            </div>
            <div className="lp-meeting-notes">
              <span /><span /><span />
            </div>
          </div>
          <LiveCursor peer={PEERS[0]} className="lp-meeting-cursor" />
        </div>
      </div>
      <div className="lp-meeting-panel">
        <div className="lp-meeting-voice">
          <div className="lp-meeting-row" aria-hidden="true">
            <PeerAvatar peer={PEERS[0]} size={24} speaking />
            <span className="lp-meeting-person"><strong>Ana</strong><small>{t('web.meetingsVisualBrowser')}</small></span>
            <LevelMeter bars={5} />
          </div>
          <button
            type="button"
            className={`lp-meeting-row is-toggle${micMuted ? ' is-off' : ''}`}
            aria-pressed={!micMuted}
            aria-label={t(micMuted ? 'voice.unmuteMic' : 'voice.muteMic')}
            onClick={() => setMicMuted(value => !value)}
          >
            <PeerAvatar peer={PEERS[3]} size={24} speaking={!micMuted} />
            <span className="lp-meeting-person" aria-hidden="true"><strong>{t('browser.you')}</strong></span>
            <LevelMeter bars={5} muted={micMuted} />
            <span className="lp-meeting-mic" aria-hidden="true">
              {micMuted ? <MicOff size={14} /> : <Mic size={14} />}
            </span>
          </button>
        </div>
        <div className="lp-meeting-collab" aria-hidden="true">
          <div className="lp-meeting-msg">
            <PeerAvatar peer={PEERS[2]} size={22} />
            <div>
              <strong>Mia</strong>
              <span>{t('web.meetingsVisualChat')}</span>
            </div>
          </div>
          <div className="lp-meeting-file">
            <span className="lp-meeting-file-icon"><FileText size={16} /></span>
            <div className="lp-meeting-file-meta">
              <strong>deck-q4.pdf</strong>
              <small>24 MB • P2P</small>
            </div>
            <ShieldCheck size={14} className="lp-meeting-file-ok" />
          </div>
        </div>
      </div>
    </div>
  );
}
