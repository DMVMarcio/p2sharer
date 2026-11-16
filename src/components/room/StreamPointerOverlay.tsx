import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { StreamDrawingLayer } from './StreamDrawingLayer';
import { StreamPointerGlyph } from './StreamPointerGlyph';
import { RemoteControlOverlayHud } from './RemoteControlOverlayHud';
import type { StreamPointerVisual } from '../../core/stream_pointer';
import type { RemoteControllerOverlayItem } from '../../core/remote_control_activity';

export function StreamPointerOverlay() {
  const [visuals, setVisuals] = useState<StreamPointerVisual[]>([]);
  const [hudItems, setHudItems] = useState<RemoteControllerOverlayItem[]>([]);

  useEffect(() => {
    let disposed = false;
    document.documentElement.classList.add('stream-pointer-desktop');
    const visualSub = listen<StreamPointerVisual[] | { visuals: StreamPointerVisual[]; drawingsIncluded: boolean }>(
      'stream-pointer-visuals',
      ({ payload }) => {
        if (!disposed) {
          setVisuals((previous) =>
            Array.isArray(payload)
              ? payload
              : payload.drawingsIncluded
                ? payload.visuals
                : [...payload.visuals, ...previous.filter((v) => v.drawing)],
          );
        }
      },
    );
    const hudSub = listen<RemoteControllerOverlayItem[]>('remote-control-hud', ({ payload }) => {
      if (!disposed) {
        setHudItems(Array.isArray(payload) ? payload : []);
      }
    });
    void Promise.all([visualSub, hudSub])
      .then(async () => {
        // Hidden WebViews may suspend animation frames; let the transparent DOM commit without requiring visibility.
        await new Promise<void>((resolve) => setTimeout(resolve, 32));
        if (disposed) return;
        const [initialVisuals, initialHud] = await Promise.all([
          invoke<StreamPointerVisual[]>('get_stream_pointer_visuals'),
          invoke<RemoteControllerOverlayItem[]>('get_remote_control_overlay').catch(() => []),
        ]);
        if (!disposed) {
          setVisuals(initialVisuals);
          setHudItems(Array.isArray(initialHud) ? initialHud : []);
        }
      })
      .catch(console.warn);
    return () => {
      disposed = true;
      void visualSub.then((unlisten) => unlisten());
      void hudSub.then((unlisten) => unlisten());
    };
  }, []);

  return (
    <div className="stream-pointer-native-layer">
      <StreamDrawingLayer visuals={visuals} />
      {visuals
        .filter((v) => !v.drawing)
        .map((v) => (
          <StreamPointerGlyph
            key={v.id}
            name={v.name}
            color={v.color}
            ping={v.ping}
            style={{ left: `${v.x * 100}%`, top: `${v.y * 100}%` }}
          />
        ))}
      <RemoteControlOverlayHud items={hudItems} />
    </div>
  );
}
