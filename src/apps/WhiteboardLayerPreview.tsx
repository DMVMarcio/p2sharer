import { memo } from 'react';
import { boardLayerBounds, DEFAULT_BOARD_LAYER, type BoardLayer, type BoardShape } from './whiteboard_scene';
import { WhiteboardLayerArt } from './WhiteboardLayerArt';

export const WhiteboardLayerPreview = memo(function WhiteboardLayerPreview({ shapes, layer, imageHref }: {
  shapes: BoardShape[]; layer: BoardLayer; imageHref?: (hash: string) => string | undefined;
}) {
  const paint = shapes.filter(s => (s.layerId ?? DEFAULT_BOARD_LAYER) === layer.id);
  const bounds = boardLayerBounds(paint, { ...layer, x: 0, y: 0 });
  const padding = bounds ? Math.max(10, Math.max(bounds.width, bounds.height) * .08) : 0;
  const viewBox = bounds ? `${bounds.x - padding} ${bounds.y - padding} ${bounds.width + padding * 2} ${bounds.height + padding * 2}` : '0 0 100 100';
  return <svg className="whiteboard-layer-preview" viewBox={viewBox} aria-hidden="true"><WhiteboardLayerArt shapes={paint} imageHref={imageHref} /></svg>;
});
