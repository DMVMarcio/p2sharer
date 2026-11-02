import { useId, type ReactNode } from 'react';
import { shapeOpacity, type BoardShape } from './whiteboard_scene';
import { WhiteboardShape } from './WhiteboardShape';

/** An eraser or clear operation affects only earlier paint in this layer; later paint remains visible. */
export function WhiteboardLayerArt({
  shapes,
  imageHref,
  canvasWidth = 1920,
  canvasHeight = 1080,
}: {
  shapes: BoardShape[];
  imageHref?: (hash: string) => string | undefined;
  canvasWidth?: number;
  canvasHeight?: number;
}) {
  const prefix = useId();
  let art: ReactNode[] = [];
  const visible = shapes.filter(s => !s.hidden);
  for (let i = 0; i < visible.length; i++) {
    const shape = visible[i];
    if (shape.tool === 'eraser' || shape.tool === 'clear') {
      const id = `${prefix}-${shape.id}`;
      art = [<g key={shape.id}>
        <defs><mask id={id} maskUnits="userSpaceOnUse" x={-16000} y={-10000} width={48000} height={30000}>
          <rect x={-16000} y={-10000} width={48000} height={30000} fill="white" />
          <WhiteboardShape shape={{ ...shape, color: '#000000', opacity: 100 }} ignoreOpacity canvasWidth={canvasWidth} canvasHeight={canvasHeight} />
        </mask></defs><g mask={`url(#${id})`}>{art}</g>
      </g>];
    } else if (shape.groupId && shapeOpacity(shape) < 1) {
      const groupOpacity = shapeOpacity(shape);
      const groupItems: ReactNode[] = [<WhiteboardShape key={shape.id} shape={shape} imageHref={shape.imageHash ? imageHref?.(shape.imageHash) : undefined} ignoreOpacity canvasWidth={canvasWidth} canvasHeight={canvasHeight} />];
      while (i + 1 < visible.length && visible[i + 1].groupId === shape.groupId && visible[i + 1].tool !== 'eraser' && visible[i + 1].tool !== 'clear') {
        i++;
        const next = visible[i];
        groupItems.push(<WhiteboardShape key={next.id} shape={next} imageHref={next.imageHash ? imageHref?.(next.imageHash) : undefined} ignoreOpacity canvasWidth={canvasWidth} canvasHeight={canvasHeight} />);
      }
      art.push(<g key={`group-${shape.id}`} opacity={groupOpacity}>{groupItems}</g>);
    } else {
      art.push(<WhiteboardShape key={shape.id} shape={shape} imageHref={shape.imageHash ? imageHref?.(shape.imageHash) : undefined} canvasWidth={canvasWidth} canvasHeight={canvasHeight} />);
    }
  }
  return <>{art}</>;
}
