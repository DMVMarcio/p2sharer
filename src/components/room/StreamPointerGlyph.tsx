import type { CSSProperties } from 'react';
import { BoxSelect, Circle, Lasso, MousePointer2, Move, PaintBucket, Pipette, TextCursor, Wand2 } from 'lucide-react';
import { VirtualCursorGlyph } from '../common/VirtualCursorGlyph';

export type StreamPointerShape =
  | 'pointer'
  | 'hand'
  | 'brush'
  | 'move'
  | 'eyedropper'
  | 'bucket'
  | 'text'
  | 'selectRect'
  | 'selectEllipse'
  | 'lasso'
  | 'wand';

const TOOL_GLYPH_SHADOW = 'drop-shadow(0 1px 2px rgba(0,0,0,0.85))';

// Shared physical-size glyph across the native desktop and every video viewport.
export function StreamPointerGlyph({ name, color, style, ping = false, interpolate = true, shape = 'pointer', diameter = 1 }: {
  name: string; color: string; style: CSSProperties; ping?: boolean; interpolate?: boolean;
  shape?: StreamPointerShape; diameter?: number;
}) {
  return <div data-cursor-shape={ping ? undefined : shape} className={ping ? 'stream-pointer-ripple' : `stream-pointer-remote${interpolate ? ' is-interpolated' : ''}`} style={{ ...style, color }}>
    {!ping && <>{shape === 'brush' ? <i className="stream-pointer-brush" style={{ width: diameter, height: diameter }} />
      : shape === 'hand' ? <VirtualCursorGlyph shape="grab" />
      : shape === 'move' ? <Move size={22} style={{ stroke: 'currentColor', strokeWidth: 2.5, transform: 'translate(-50%, -50%)' }} />
      : shape === 'eyedropper' ? <Pipette size={22} className="stream-pointer-eyedropper" style={{ stroke: '#ffffff', fill: 'currentColor', strokeWidth: 2.2, transform: 'translate(-2px, -20px)', filter: TOOL_GLYPH_SHADOW }} />
      : shape === 'bucket' ? <PaintBucket size={22} className="stream-pointer-bucket" style={{ stroke: '#ffffff', fill: 'currentColor', strokeWidth: 2, transform: 'translate(-18px, -20px)', filter: TOOL_GLYPH_SHADOW }} />
      : shape === 'text' ? <TextCursor size={20} className="stream-pointer-text" style={{ stroke: '#ffffff', strokeWidth: 2.4, transform: 'translate(-10px, -10px)', filter: TOOL_GLYPH_SHADOW }} />
      : shape === 'wand' ? <Wand2 size={22} className="stream-pointer-wand" style={{ stroke: '#ffffff', fill: 'currentColor', strokeWidth: 2, transform: 'translate(-18px, -4px)', filter: TOOL_GLYPH_SHADOW }} />
      : shape === 'lasso' ? <span className="stream-pointer-selection is-lasso" style={{ filter: TOOL_GLYPH_SHADOW }}>
        <i className="stream-pointer-crosshair" />
        <Lasso size={16} className="stream-pointer-lasso" style={{ stroke: '#ffffff', strokeWidth: 2.2, transform: 'translate(3px, -18px)' }} />
      </span>
      : shape === 'selectRect' ? <span className="stream-pointer-selection is-rect" style={{ filter: TOOL_GLYPH_SHADOW }}>
        <i className="stream-pointer-crosshair" />
        <BoxSelect size={14} className="stream-pointer-marquee-badge" style={{ stroke: '#ffffff', strokeWidth: 2.2, transform: 'translate(4px, 4px)' }} />
      </span>
      : shape === 'selectEllipse' ? <span className="stream-pointer-selection is-ellipse" style={{ filter: TOOL_GLYPH_SHADOW }}>
        <i className="stream-pointer-crosshair" />
        <Circle size={13} className="stream-pointer-marquee-badge" style={{ stroke: '#ffffff', strokeWidth: 2.2, strokeDasharray: '3 2', transform: 'translate(4px, 4px)' }} />
      </span>
      : <MousePointer2 size={22} fill="currentColor" />}
      {name && <span>{name}</span>}</>}
  </div>;
}
