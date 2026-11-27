import { useRef, type CSSProperties } from 'react';
import { Check, FileVideo, FolderUp, Lock, Mic, MicOff, Monitor, SendHorizontal, Volume2 } from 'lucide-react';
import { t } from '../../../src/i18n';
import logo from '../../../src/assets/logo.png';
import { LevelMeter, LiveCursor, PEERS, PeerAvatar } from './scenes';
import { useInView, useLoopStep, usePointerTilt } from './motion';
import { RacingScene } from './screenScenes';

const CHAT = [
  { peer: PEERS[0], text: 'web.mockChat1' },
  { peer: PEERS[1], text: 'web.mockChat2' },
] as const;

/** Animated, decorative reproduction of a live P2Sharer room for the landing hero. */
export function HeroRoomPreview() {
  const ref = useRef<HTMLDivElement>(null);
  const active = useInView(ref);
  usePointerTilt(ref);
  // 0: empty chat, 1-2: messages, 3: file offer, 4: transfer, 5: verified.
  const step = useLoopStep(6, 1500, active, 3);
  return (
    <div ref={ref} className="lp-hero-visual" data-active={active || undefined} aria-hidden="true">
      <div className="lp-hero-halo" />
      <div className="lp-window">
        <div className="lp-window-bar">
          <img src={logo} alt="" />
          <strong>{t('web.mockRoomName')}</strong>
          <span className="lp-chip is-lock"><Lock size={11} />E2EE</span>
          <span className="lp-window-peers">
            {PEERS.slice(0, 3).map(peer => <PeerAvatar key={peer.name} peer={peer} size={22} />)}
          </span>
          <span className="lp-live-dot">{t('message.f4f7456d8037')}</span>
        </div>
        <div className="lp-window-body">
          <div className="lp-stage">
            <div className="lp-screen">
              <RacingScene />
              <svg className="lp-annotation" viewBox="0 0 100 60" preserveAspectRatio="none">
                <ellipse cx="50" cy="44" rx="12" ry="10" />
              </svg>
              <LiveCursor peer={PEERS[0]} className="lp-screen-cursor" />
              <div className="lp-screen-hud">
                <span className="lp-chip is-glass"><Monitor size={11} />Leo</span>
                <span className="lp-chip is-glass is-mono">4K • 120 FPS</span>
              </div>
              <span className="lp-screen-audio"><Volume2 size={12} /><LevelMeter bars={4} /></span>
            </div>
            <div className="lp-cams">
              {PEERS.slice(0, 3).map((peer, index) => (
                <div key={peer.name} className="lp-cam" style={{ '--peer': peer.color } as CSSProperties}>
                  <PeerAvatar peer={peer} size={34} speaking={index === 0} />
                  <span className="lp-cam-name">
                    {index === 2 ? <MicOff size={10} /> : <Mic size={10} />}
                    {peer.name}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <aside className="lp-chat">
            <div className="lp-chat-head">{t('twitch.chat')}</div>
            <div className="lp-chat-list">
              {CHAT.map((message, index) => (
                <div key={message.text} className="lp-msg" data-shown={step > index || undefined}>
                  <PeerAvatar peer={message.peer} size={20} />
                  <div>
                    <b style={{ color: message.peer.color }}>{message.peer.name}</b>
                    <p>{t(message.text)}</p>
                  </div>
                </div>
              ))}
              <div className="lp-msg is-file" data-shown={step > 2 || undefined}>
                <PeerAvatar peer={PEERS[2]} size={20} />
                <div>
                  <b style={{ color: PEERS[2].color }}>Mia</b>
                  <div className="lp-file-card" data-state={step >= 5 ? 'done' : step >= 4 ? 'sending' : 'offer'}>
                    <FileVideo size={16} />
                    <span className="lp-file-meta">
                      <strong>clip-4k.mp4</strong>
                      <small>2.4 GB</small>
                      <span className="lp-file-bar"><i /></span>
                    </span>
                    <span className="lp-file-state">{step >= 5 ? <Check size={13} /> : <FolderUp size={13} />}</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="lp-composer">
              <span>{t('message.322085898310')}</span>
              <SendHorizontal size={13} />
            </div>
          </aside>
        </div>
      </div>
      <div className="lp-float lp-float-a"><span className="lp-float-icon"><Monitor size={14} /></span>4K • 120 FPS</div>
      <div className="lp-float lp-float-b"><span className="lp-float-icon"><Lock size={14} /></span>{t('web.pillE2ee')}</div>
      <div className="lp-float lp-float-c"><span className="lp-float-icon"><FolderUp size={14} /></span>{t('web.pillUnlimitedFiles')}</div>
    </div>
  );
}
