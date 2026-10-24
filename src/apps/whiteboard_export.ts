import { blobToPngBlob, blobToDataUrl } from '../core/image_clipboard';
import { boardSvg, type BoardLayer, type BoardShape } from './whiteboard_scene';

export async function boardPng(shapes: BoardShape[], layers: BoardLayer[], images?: ReadonlyMap<string, string> | Record<string, string>, removeMargins = true): Promise<string> {
  const blob = await blobToPngBlob(new Blob([boardSvg(shapes, layers, true, images)], { type: 'image/svg+xml' }), removeMargins ? 10 : undefined);
  return blobToDataUrl(blob);
}
