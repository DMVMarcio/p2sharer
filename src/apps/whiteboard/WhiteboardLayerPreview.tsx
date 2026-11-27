import { memo, useEffect, useRef } from 'react';
import { boardLayerBounds, DEFAULT_BOARD_LAYER, type BoardLayer, type BoardShape } from './whiteboard_scene';
import { WhiteboardLayerArt } from './WhiteboardLayerArt';
import type { WhiteboardStudioCompositor } from './whiteboard_webgl';

export const WhiteboardLayerPreview = memo(function WhiteboardLayerPreview({
  shapes,
  layers,
  layer,
  imageHref,
  studio,
  engineActive = false,
  boardWidth = 1920,
  boardHeight = 1080,
}: {
  shapes: BoardShape[];
  layers?: BoardLayer[];
  layer: BoardLayer;
  imageHref?: (hash: string) => string | undefined;
  studio?: WhiteboardStudioCompositor | null;
  engineActive?: boolean;
  boardWidth?: number;
  boardHeight?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastSigRef = useRef('');

  useEffect(() => {
    if (!engineActive || !studio || !canvasRef.current) return;
    let sig = `${boardWidth}x${boardHeight}:${layer.alphaLock ? 1 : 0}:`;
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      if (s.hidden || (s.layerId ?? DEFAULT_BOARD_LAYER) !== layer.id) continue;
      sig += `${s.id}:${s.order}:${s.points.length}:${s.x}:${s.y}:${s.scaleX ?? 1}:${s.scaleY ?? 1}:${s.color};`;
    }
    if (sig === lastSigRef.current) return;
    if (studio.drawLayerThumbnail(layer.id, canvasRef.current, layers ?? [layer], shapes, boardWidth, boardHeight)) {
      lastSigRef.current = sig;
    }
  }, [engineActive, studio, layer.id, layer.alphaLock, layers, shapes, boardWidth, boardHeight]);

  if (engineActive && studio) {
    return <canvas ref={canvasRef} width={88} height={88} className="whiteboard-layer-preview" aria-hidden="true" />;
  }

  const paint = shapes.filter(s => (s.layerId ?? DEFAULT_BOARD_LAYER) === layer.id);
  const bounds = boardLayerBounds(paint, { ...layer, x: 0, y: 0 });
  const padding = bounds ? Math.max(10, Math.max(bounds.width, bounds.height) * .08) : 0;
  const viewBox = bounds ? `${bounds.x - padding} ${bounds.y - padding} ${bounds.width + padding * 2} ${bounds.height + padding * 2}` : '0 0 100 100';
  return <svg className="whiteboard-layer-preview" viewBox={viewBox} aria-hidden="true"><WhiteboardLayerArt shapes={paint} imageHref={imageHref} /></svg>;
});

