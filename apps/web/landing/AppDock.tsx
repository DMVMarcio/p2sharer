import { useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowRight, Check, Crown, FileText, FileVideo, Globe, MessageSquare, Network, Palette, Play, Tv } from 'lucide-react';
import { t } from '../../../src/i18n';
import { LiveCursor, MiniChessBoard, PEERS, PeerAvatar, WhiteboardSketch } from './scenes';
import { useAutoCycle, useInView, useLoopStep } from './motion';
import { CycleTimer } from './CycleTimer';

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
  const ref = useRef<HTMLDivElement>(null);
  const step = useLoopStep(5, 700, useInView(ref), 4);
  const messages = [
    { peer: PEERS[0], text: 'web.mockChat1' },
    { peer: PEERS[3], text: 'web.mockChat3', own: true, file: true },
    { peer: PEERS[1], text: 'web.mockChat2', reactions: true },
  ];
  return (
    <div ref={ref} className="lp-scene lp-scene-chat">
      {messages.map((message, index) => (
        <div
          key={message.text}
          className={`lp-bubble${message.own ? ' is-own' : ''}`}
          data-shown={step > index || undefined}
          style={{ '--peer': message.peer.color } as CSSProperties}
        >
          <PeerAvatar peer={message.peer} size={26} />
          <div className="lp-bubble-body">
            <b>{message.peer.name}</b>
            <p>{t(message.text)}</p>
            {message.file && (
              <span className="lp-bubble-file" data-done={step > 3 || undefined}>
                <FileVideo size={15} />
                <span><strong>trip.mov</strong><small>6.1 GB</small><i><em /></i></span>
                <Check size={13} />
              </span>
            )}
            {message.reactions && (
              <span className="lp-bubble-reactions"><span>🔥 3</span><span>😂 2</span></span>
            )}
          </div>
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

const CYCLE_MS = 5200;

/** Interactive dock of room apps; rotates automatically and restarts its timer when the visitor picks one. */
export function AppDock() {
  const ref = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const active = useInView(ref);
  const { index, select, running, cycle, focusHandlers } = useAutoCycle(APPS.length, CYCLE_MS, active);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: APPS.length - 1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const next = (keys[event.key] + APPS.length) % APPS.length;
    select(next);
    tabs.current[next]?.focus();
  };

  const app = APPS[index];
  const Scene = app.scene;
  return (
    <div ref={ref} className="lp-dock" data-active={active || undefined} style={{ '--tone': app.tone } as CSSProperties} {...focusHandlers}>
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
              {selected && <CycleTimer running={running} cycle={cycle} duration={CYCLE_MS} />}
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
