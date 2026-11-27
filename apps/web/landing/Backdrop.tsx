import type { CSSProperties } from 'react';
import { PEERS } from './scenes';

/*
 * Decorative page background: a faded dot grid, soft color glows spread down
 * the page and small peer-to-peer meshes in the side margins whose "packets"
 * travel between nodes. Everything is aria-hidden and drifts with scroll
 * only where scroll-driven animations are supported.
 */

const NODES = [
  { x: 40, y: 50, r: 7 },
  { x: 150, y: 28, r: 5 },
  { x: 210, y: 120, r: 8 },
  { x: 92, y: 150, r: 5 },
  { x: 170, y: 218, r: 6 },
  { x: 56, y: 236, r: 4 },
] as const;

const EDGES = [[0, 1], [1, 2], [0, 3], [3, 2], [2, 4], [3, 5], [5, 4], [1, 3]] as const;
const PACKET_EDGES = [0, 3, 4, 6];

const MESHES = [
  { top: '9%', side: 'left', flip: false, depth: 0.6 },
  { top: '27%', side: 'right', flip: true, depth: 1 },
  { top: '48%', side: 'left', flip: true, depth: 0.8 },
  { top: '69%', side: 'right', flip: false, depth: 0.6 },
  { top: '88%', side: 'left', flip: false, depth: 1 },
] as const;

const GLOWS = ['is-a', 'is-b', 'is-c', 'is-d', 'is-e', 'is-f'] as const;

function PeerMesh({ index }: { index: number }) {
  return (
    <svg viewBox="0 0 260 260" aria-hidden="true">
      <g className="lp-mesh-edges">
        {EDGES.map(([from, to]) => (
          <line key={`${from}-${to}`} x1={NODES[from].x} y1={NODES[from].y} x2={NODES[to].x} y2={NODES[to].y} />
        ))}
      </g>
      {PACKET_EDGES.map((edge, order) => {
        const [from, to] = EDGES[edge];
        const peer = PEERS[(order + index) % PEERS.length];
        return (
          <line
            key={edge}
            className="lp-mesh-packet"
            pathLength={100}
            x1={NODES[from].x} y1={NODES[from].y} x2={NODES[to].x} y2={NODES[to].y}
            stroke={peer.color}
            style={{ animationDelay: `${-(order * 1.3 + index * 0.7)}s` }}
          />
        );
      })}
      {NODES.map((node, nodeIndex) => (
        <circle
          key={nodeIndex}
          className="lp-mesh-node"
          cx={node.x} cy={node.y} r={node.r}
          fill={PEERS[(nodeIndex + index) % PEERS.length].color}
          style={{ animationDelay: `${-nodeIndex * 0.6}s` }}
        />
      ))}
    </svg>
  );
}

export function LandingBackdrop() {
  return (
    <div className="lp-backdrop" aria-hidden="true">
      <span className="lp-backdrop-grid" />
      {GLOWS.map(glow => <span key={glow} className={`lp-orb ${glow}`} />)}
      {MESHES.map((mesh, index) => (
        <span
          key={mesh.top}
          className={`lp-mesh is-${mesh.side}${mesh.flip ? ' is-flipped' : ''}`}
          style={{ top: mesh.top, '--depth': mesh.depth } as CSSProperties}
        >
          <PeerMesh index={index} />
        </span>
      ))}
    </div>
  );
}
