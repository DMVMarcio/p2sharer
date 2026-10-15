import type { CSSProperties } from 'react';
import { MousePointer2 } from 'lucide-react';
import { VirtualCursorGlyph } from '../common/VirtualCursorGlyph';

// Shared physical-size glyph across the native desktop and every video viewport.
export function StreamPointerGlyph({ name, color, style, ping = false, interpolate = true, shape = 'pointer', diameter = 1 }: {
  name: string; color: string; style: CSSProperties; ping?: boolean; interpolate?: boolean;
  shape?: 'pointer' | 'hand' | 'brush'; diameter?: number;
}) {
  return <div className={ping ? 'stream-pointer-ripple' : `stream-pointer-remote${interpolate ? ' is-interpolated' : ''}`} style={{ ...style, color }}>
    {!ping && <>{shape === 'brush' ? <i className="stream-pointer-brush" style={{ width: diameter, height: diameter }} />
      : shape === 'hand' ? <VirtualCursorGlyph shape="grab" /> : <MousePointer2 size={22} fill="currentColor" />}
      {name && <span>{name}</span>}</>}
  </div>;
}
