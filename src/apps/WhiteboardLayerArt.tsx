import { useId, type ReactNode } from 'react';
import { shapeOpacity, type BoardShape } from './whiteboard_scene';
import { WhiteboardShape } from './WhiteboardShape';

/** An eraser affects only earlier paint in this layer; later paint remains visible. */
export function WhiteboardLayerArt({ shapes, imageHref }: { shapes: BoardShape[]; imageHref?: (hash: string) => string | undefined }) {
  const prefix = useId();
  let art: ReactNode[] = [];
  const visible = shapes.filter(s => !s.hidden);
  for (let i = 0; i < visible.length; i++) {
    const shape = visible[i];
    if (shape.tool === 'eraser') {
      const id = `${prefix}-${shape.id}`;
      art = [<g key={shape.id}>
        <defs><mask id={id} maskUnits="userSpaceOnUse" x={-16000} y={-10000} width={48000} height={30000}>
          <rect x={-16000} y={-10000} width={48000} height={30000} fill="white" />
          <WhiteboardShape shape={{ ...shape, color: '#000000', opacity: 100 }} ignoreOpacity />
        </mask></defs><g mask={`url(#${id})`}>{art}</g>
      </g>];
    } else if (shape.groupId && shapeOpacity(shape) < 1) {
      const groupOpacity = shapeOpacity(shape);
      const groupItems: ReactNode[] = [<WhiteboardShape key={shape.id} shape={shape} imageHref={shape.imageHash ? imageHref?.(shape.imageHash) : undefined} ignoreOpacity />];
      while (i + 1 < visible.length && visible[i + 1].groupId === shape.groupId && visible[i + 1].tool !== 'eraser') {
        i++;
        const next = visible[i];
        groupItems.push(<WhiteboardShape key={next.id} shape={next} imageHref={next.imageHash ? imageHref?.(next.imageHash) : undefined} ignoreOpacity />);
      }
      art.push(<g key={`group-${shape.id}`} opacity={groupOpacity}>{groupItems}</g>);
    } else {
      art.push(<WhiteboardShape key={shape.id} shape={shape} imageHref={shape.imageHash ? imageHref?.(shape.imageHash) : undefined} />);
    }
  }
  return <>{art}</>;
}
