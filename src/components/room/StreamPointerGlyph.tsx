import type { CSSProperties } from 'react';
import { MousePointer2, Move, Pipette } from 'lucide-react';
import { VirtualCursorGlyph } from '../common/VirtualCursorGlyph';

// Shared physical-size glyph across the native desktop and every video viewport.
export function StreamPointerGlyph({ name, color, style, ping = false, interpolate = true, shape = 'pointer', diameter = 1 }: {
  name: string; color: string; style: CSSProperties; ping?: boolean; interpolate?: boolean;
  shape?: 'pointer' | 'hand' | 'brush' | 'move' | 'eyedropper'; diameter?: number;
}) {
  return <div data-cursor-shape={ping ? undefined : shape} className={ping ? 'stream-pointer-ripple' : `stream-pointer-remote${interpolate ? ' is-interpolated' : ''}`} style={{ ...style, color }}>
    {!ping && <>{shape === 'brush' ? <i className="stream-pointer-brush" style={{ width: diameter, height: diameter }} />
      : shape === 'hand' ? <VirtualCursorGlyph shape="grab" /> : shape === 'move' ? <Move size={22} style={{ stroke: 'currentColor', strokeWidth: 2.5, transform: 'translate(-50%, -50%)' }} />
      : shape === 'eyedropper' ? <Pipette size={22} className="stream-pointer-eyedropper" style={{ stroke: '#ffffff', fill: 'currentColor', strokeWidth: 2.2, transform: 'translate(-2px, -20px)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.85))' }} />
      : <MousePointer2 size={22} fill="currentColor" />}
      {name && <span>{name}</span>}</>}
  </div>;
}
