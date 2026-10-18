import { blobToPngBlob, blobToDataUrl } from '../core/image_clipboard';
import { boardSvg, type BoardLayer, type BoardShape } from './whiteboard_scene';

export async function boardPng(shapes: BoardShape[], layers: BoardLayer[], images?: ReadonlyMap<string, string> | Record<string, string>): Promise<string> {
  const blob = await blobToPngBlob(new Blob([boardSvg(shapes, layers, true, images)], { type: 'image/svg+xml' }));
  return blobToDataUrl(blob);
}
