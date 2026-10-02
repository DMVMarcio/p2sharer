import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { StreamDrawingLayer } from './StreamDrawingLayer';
import { StreamPointerGlyph } from './StreamPointerGlyph';
import type { StreamPointerVisual } from '../../core/stream_pointer';

export function StreamPointerOverlay() {
  const [visuals, setVisuals] = useState<StreamPointerVisual[]>([]);
  useEffect(() => {
    let disposed = false;
    document.documentElement.classList.add('stream-pointer-desktop');
    const subscription = listen<StreamPointerVisual[] | { visuals: StreamPointerVisual[]; drawingsIncluded: boolean }>('stream-pointer-visuals', ({ payload }) => {
      if (!disposed) setVisuals(previous => Array.isArray(payload) ? payload : payload.drawingsIncluded ? payload.visuals
        : [...payload.visuals, ...previous.filter(v => v.drawing)]);
    });
    void subscription.then(async () => {
      // Hidden WebViews may suspend animation frames; let the transparent DOM commit without requiring visibility.
      await new Promise<void>(resolve => setTimeout(resolve, 32));
      if (disposed) return;
      const initial = await invoke<StreamPointerVisual[]>('get_stream_pointer_visuals');
      if (!disposed) setVisuals(initial);
    }).catch(console.warn);
    return () => { disposed = true; void subscription.then((unlisten) => unlisten()); };
  }, []);
  return <div className="stream-pointer-native-layer"><StreamDrawingLayer visuals={visuals} />{visuals.filter(v => !v.drawing).map((v) =>
    <StreamPointerGlyph key={v.id} name={v.name} color={v.color} ping={v.ping}
      style={{ left: `${v.x * 100}%`, top: `${v.y * 100}%` }} />)}</div>;
}
