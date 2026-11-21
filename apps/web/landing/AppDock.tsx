import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Crown, FileText, Globe, MessageSquare, Network, Palette, Play, Tv, ArrowRight, Paperclip } from 'lucide-react';
import { t } from '../../../src/i18n';
import { useReducedMotion } from '../../../src/core/appearance_preferences';
import { LiveCursor, MiniChessBoard, PEERS, PeerAvatar, WhiteboardSketch } from './scenes';
import { useInView } from './motion';

function YoutubeScene() {
  return (
    <div className="lp-scene lp-scene-youtube">
      <div className="lp-scene-video"><span className="lp-scene-play"><Play size={18} /></span><span className="lp-scene-progress"><i /></span></div>
      <div className="lp-scene-queue">
        {[0, 1, 2, 3].map(index => <span key={index} style={{ '--i': index } as CSSProperties}><i /><b /></span>)}
      </div>
    </div>
  );
}

function TwitchScene() {
  return (
    <div className="lp-scene lp-scene-twitch">
      <div className="lp-scene-video"><span className="lp-scene-live">{t('twitch.live')}</span><span className="lp-scene-viewers">● 1.2k</span></div>
      <div className="lp-scene-feed">
        {[...PEERS, ...PEERS].map((peer, index) => (
          <span key={index} style={{ '--i': index, '--peer': peer.color } as CSSProperties}><b>{peer.name}</b><i /></span>
        ))}
      </div>
    </div>
  );
}

function NotepadScene() {
  return (
    <div className="lp-scene lp-scene-notepad">
      <span className="lp-note-title" />
      <span className="lp-note-line" style={{ '--w': '92%' } as CSSProperties} />
      <span className="lp-note-line" style={{ '--w': '78%' } as CSSProperties} />
      <div className="lp-note-code">
        <span style={{ '--w': '46%', '--c': '#c084fc' } as CSSProperties} />
        <span style={{ '--w': '64%', '--c': '#38bdf8' } as CSSProperties} />
        <span style={{ '--w': '38%', '--c': '#a3e635' } as CSSProperties} />
      </div>
      <span className="lp-note-line is-typing" style={{ '--w': '58%', '--peer': PEERS[0].color } as CSSProperties}><LiveCursor peer={PEERS[0]} className="lp-note-cursor" /></span>
    </div>
  );
}

function ChatScene() {
  return (
    <div className="lp-scene lp-scene-chat">
      {PEERS.slice(0, 3).map((peer, index) => (
        <div key={peer.name} className={`lp-bubble${index === 1 ? ' is-own' : ''}`} style={{ '--i': index, '--peer': peer.color } as CSSProperties}>
          <PeerAvatar peer={peer} size={22} />
          <span><i style={{ '--w': `${60 + index * 12}%` } as CSSProperties} />{index === 2 && <em><Paperclip size={11} />trip.mov · 6.1 GB</em>}</span>
        </div>
      ))}
    </div>
  );
}

function BrowserScene() {
  return (
    <div className="lp-scene lp-scene-browser">
      <div className="lp-browser-tabs"><span className="is-active" /><span /><span /></div>
      <div className="lp-browser-url"><Globe size={11} /><i /></div>
      <div className="lp-browser-page">
        <span className="lp-browser-hero" />
        <span className="lp-browser-row"><i /><i /><i /></span>
        <LiveCursor peer={PEERS[1]} className="lp-browser-cursor-a" />
        <LiveCursor peer={PEERS[3]} className="lp-browser-cursor-b" />
      </div>
    </div>
  );
}

function TunnelScene() {
  const rows = [
    { proto: 'TCP', port: '25565', peer: PEERS[0] },
    { proto: 'UDP', port: '7777', peer: PEERS[1] },
    { proto: 'TCP', port: '3000', peer: PEERS[2] },
  ];
  return (
    <div className="lp-scene lp-scene-tunnel">
      {rows.map((row, index) => (
        <div key={row.port} className="lp-tunnel-row" style={{ '--i': index, '--peer': row.peer.color } as CSSProperties}>
          <span className="lp-tunnel-proto">{row.proto}</span>
          <strong>:{row.port}</strong>
          <span className="lp-tunnel-flow"><i /><ArrowRight size={12} /></span>
          <PeerAvatar peer={row.peer} size={22} />
          <span className="lp-tunnel-dot" />
        </div>
      ))}
    </div>
  );
}

const APPS: { id: string; tone: string; icon: typeof Play; title: string; description: string; badge: string; scene: () => ReactNode }[] = [
  { id: 'youtube', tone: '#ef4444', icon: Play, title: 'web.appYoutubeTitle', description: 'web.appYoutubeDesc', badge: 'web.appBadgeAll', scene: YoutubeScene },
  { id: 'twitch', tone: '#a855f7', icon: Tv, title: 'web.appTwitchTitle', description: 'web.appTwitchDesc', badge: 'web.appBadgeAll', scene: TwitchScene },
  { id: 'games', tone: '#f59e0b', icon: Crown, title: 'web.appGamesTitle', description: 'web.appGamesDesc', badge: 'web.appBadgeAll', scene: () => <div className="lp-scene lp-scene-games"><MiniChessBoard /></div> },
  { id: 'whiteboard', tone: '#ec4899', icon: Palette, title: 'web.appWhiteboardTitle', description: 'web.appWhiteboardDesc', badge: 'web.appBadgeAll', scene: () => <div className="lp-scene lp-scene-board"><WhiteboardSketch /></div> },
  { id: 'notepad', tone: '#22c55e', icon: FileText, title: 'web.appNotepadTitle', description: 'web.appNotepadDesc', badge: 'web.appBadgeAll', scene: NotepadScene },
  { id: 'chat', tone: '#06b6d4', icon: MessageSquare, title: 'web.appChatTitle', description: 'web.appChatDesc', badge: 'web.appBadgeAll', scene: ChatScene },
  { id: 'browser', tone: '#3b82f6', icon: Globe, title: 'web.appBrowserTitle', description: 'web.appBrowserDesc', badge: 'web.appBadgeDesktopHost', scene: BrowserScene },
  { id: 'tunnels', tone: '#14b8a6', icon: Network, title: 'web.appTunnelsTitle', description: 'web.appTunnelsDesc', badge: 'web.appBadgeDesktop', scene: TunnelScene },
];

/** Interactive dock of room apps; cycles automatically until the visitor picks one. */
export function AppDock() {
  const ref = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const active = useInView(ref);
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [manual, setManual] = useState(false);
  const [hovering, setHovering] = useState(false);
  const cycling = active && !manual && !reduced && !hovering;

  useEffect(() => {
    if (!cycling) return;
    const timer = window.setInterval(() => setIndex(current => (current + 1) % APPS.length), 4600);
    return () => window.clearInterval(timer);
  }, [cycling]);

  const select = (next: number, focus = false) => {
    setManual(true);
    setIndex(next);
    if (focus) tabs.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: APPS.length - 1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    select((keys[event.key] + APPS.length) % APPS.length, true);
  };

  const app = APPS[index];
  const Scene = app.scene;
  return (
    <div
      ref={ref}
      className="lp-dock"
      data-active={active || undefined}
      style={{ '--tone': app.tone } as CSSProperties}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
    >
      <div className="lp-dock-tabs" role="tablist" aria-label={t('web.navApps')} aria-orientation="vertical" onKeyDown={onKeyDown}>
        {APPS.map((item, itemIndex) => {
          const Icon = item.icon;
          const selected = itemIndex === index;
          return (
            <button
              key={item.id}
              ref={element => { tabs.current[itemIndex] = element; }}
              type="button"
              role="tab"
              id={`${id}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`${id}-panel`}
              tabIndex={selected ? 0 : -1}
              className="lp-dock-tab"
              style={{ '--tone': item.tone } as CSSProperties}
              onClick={() => select(itemIndex)}
            >
              <span className="lp-dock-icon" aria-hidden="true"><Icon size={17} /></span>
              <span className="lp-dock-label">{t(item.title)}</span>
              {selected && cycling && <span className="lp-dock-timer" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <div className="lp-dock-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${app.id}`}>
        <div key={app.id} className="lp-dock-stage" aria-hidden="true">
          <Scene />
        </div>
        <div key={`${app.id}-copy`} className="lp-dock-copy">
          <span className="lp-dock-badge">{t(app.badge)}</span>
          <h3>{t(app.title)}</h3>
          <p>{t(app.description)}</p>
        </div>
      </div>
    </div>
  );
}
