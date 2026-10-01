import type { CSSProperties } from 'react';
import { MousePointer2 } from 'lucide-react';

// Shared physical-size glyph across the native desktop and every video viewport.
export function StreamPointerGlyph({ name, color, style, ping = false }: {
  name: string; color: string; style: CSSProperties; ping?: boolean;
}) {
  return <div className={ping ? 'stream-pointer-ripple' : 'stream-pointer-remote'} style={{ ...style, color }}>
    {!ping && <><MousePointer2 size={22} fill="currentColor" /><span>{name}</span></>}
  </div>;
}
