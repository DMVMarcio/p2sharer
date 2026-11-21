import { useRef, type CSSProperties } from 'react';
import { KeyRound, Lock, Radio, Server } from 'lucide-react';
import { t } from '../../../src/i18n';
import { PEERS, PeerAvatar } from './scenes';
import { useAutoCycle, useInView } from './motion';
import { CycleTimer } from './CycleTimer';

const CYCLE_MS = 5200;

const STEPS = [
  { icon: KeyRound, title: 'web.step1Title', description: 'web.step1Desc' },
  { icon: Radio, title: 'web.step2Title', description: 'web.step2Desc' },
  { icon: Lock, title: 'web.step3Title', description: 'web.step3Desc' },
] as const;

const RELAY = { x: 240, y: 46 };
const NODES = [
  { peer: PEERS[3], x: 92, y: 176, you: true },
  { peer: PEERS[0], x: 388, y: 168 },
  { peer: PEERS[1], x: 168, y: 280 },
  { peer: PEERS[2], x: 318, y: 282 },
] as const;
const LINKS = NODES.flatMap((from, i) => NODES.slice(i + 1).map(to => ({ from, to })));

/** Interactive, auto-advancing walkthrough of how a room connects: local keys, discovery, then a direct encrypted mesh. */
export function P2PJourney() {
  const ref = useRef<HTMLDivElement>(null);
  const active = useInView(ref);
  const { index: phase, select, running, cycle, focusHandlers } = useAutoCycle(STEPS.length, CYCLE_MS, active);

  return (
    <div ref={ref} className="lp-journey" data-phase={phase} data-active={active || undefined} {...focusHandlers}>
      <ol className="lp-journey-steps">
        {STEPS.map(({ icon: Icon, title, description }, index) => (
          <li key={title}>
            <button
              type="button"
              className="lp-journey-step"
              aria-pressed={phase === index}
              onClick={() => select(index)}
            >
              <span className="lp-journey-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <span className="lp-journey-icon" aria-hidden="true"><Icon size={17} /></span>
              <span className="lp-journey-text">
                <strong>{t(title)}</strong>
                <span>{t(description)}</span>
              </span>
              {phase === index && <CycleTimer running={running} cycle={cycle} duration={CYCLE_MS} />}
            </button>
          </li>
        ))}
      </ol>
      <div className="lp-journey-map" aria-hidden="true">
        <svg viewBox="0 0 480 330">
          <g className="lp-relay-links">
            {NODES.map(node => <line key={node.peer.name} x1={RELAY.x} y1={RELAY.y} x2={node.x} y2={node.y} />)}
          </g>
          <g className="lp-mesh-links">
            {LINKS.map(({ from, to }) => (
              <line key={`${from.peer.name}-${to.peer.name}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
            ))}
          </g>
        </svg>
        <div className="lp-relay" style={{ left: `${RELAY.x / 4.8}%`, top: `${RELAY.y / 3.3}%` }}>
          <Server size={18} />
        </div>
        {NODES.map((node, index) => (
          <div
            key={node.peer.name}
            className="lp-node"
            style={{ left: `${node.x / 4.8}%`, top: `${node.y / 3.3}%`, '--peer': node.peer.color, '--i': index } as CSSProperties}
          >
            <PeerAvatar peer={node.peer} size={44} />
            <span className="lp-node-name">{'you' in node ? t('browser.you') : node.peer.name}</span>
            <span className="lp-node-key"><KeyRound size={11} /></span>
            <span className="lp-node-lock"><Lock size={11} /></span>
          </div>
        ))}
      </div>
    </div>
  );
}
