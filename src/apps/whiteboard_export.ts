import { blobToPngBlob, blobToDataUrl } from '../core/image_clipboard';
import { boardSvg, type BoardLayer, type BoardShape } from './whiteboard_scene';

export async function boardPng(shapes: BoardShape[], layers: BoardLayer[]): Promise<string> {
  const blob = await blobToPngBlob(new Blob([boardSvg(shapes, layers, true)], { type: 'image/svg+xml' }));
  return blobToDataUrl(blob);
}
