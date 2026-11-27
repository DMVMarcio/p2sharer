import { blobToPngBlob, blobToDataUrl, trimWhiteCanvasMargins } from '../core/image_clipboard';
import {
  boardSvg, defaultBoardCanvasSettings,
  type BoardCanvasSettings, type BoardLayer, type BoardShape,
} from './whiteboard_scene';
import { WhiteboardCanvas2DRenderer } from './whiteboard_canvas2d';

async function decodeImagesForExport(
  renderer: WhiteboardCanvas2DRenderer,
  images?: ReadonlyMap<string, string> | Record<string, string>,
): Promise<void> {
  if (!images || typeof Image === 'undefined') return;
  const entries = images instanceof Map ? [...images.entries()] : Object.entries(images);
  await Promise.all(entries.map(([hash, raw]) => new Promise<void>(resolve => {
    const img = new Image();
    img.onload = () => {
      renderer.registerImage(hash, img);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = raw.startsWith('data:') || raw.startsWith('blob:') ? raw : `data:image/png;base64,${raw}`;
  })));
}

export async function boardPng(
  shapes: BoardShape[],
  layers: BoardLayer[],
  images?: ReadonlyMap<string, string> | Record<string, string>,
  removeMargins = true,
  canvasSettings?: BoardCanvasSettings,
): Promise<string> {
  const settings = canvasSettings ?? defaultBoardCanvasSettings();
  if (typeof document !== 'undefined') {
    const probe = document.createElement('canvas');
    probe.width = settings.width;
    probe.height = settings.height;
    const ctx = probe.getContext('2d');
    if (ctx && typeof ctx.createRadialGradient === 'function' && typeof ctx.putImageData === 'function' && typeof probe.toBlob === 'function') {
      const renderer = new WhiteboardCanvas2DRenderer();
      await decodeImagesForExport(renderer, images);
      const rendered = renderer.renderScene(
        probe,
        layers,
        shapes,
        new Map(),
        null,
        null,
        settings.width,
        settings.height,
        settings.backgroundColor,
        settings.transparent,
      );
      if (rendered) {
        const output = removeMargins && !settings.transparent ? trimWhiteCanvasMargins(probe, 10) : probe;
        const pngBlob = await new Promise<Blob>((resolve, reject) => {
          output.toBlob(
            b => (b ? resolve(b) : reject(new Error('PNG export failed'))),
            'image/png',
          );
        });
        return blobToDataUrl(pngBlob);
      }
    }
  }

  const blob = await blobToPngBlob(
    new Blob([boardSvg(shapes, layers, true, images, canvasSettings)], { type: 'image/svg+xml' }),
    removeMargins ? 10 : undefined,
  );
  return blobToDataUrl(blob);
}
