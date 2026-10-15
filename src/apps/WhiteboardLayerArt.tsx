import { useId, type ReactNode } from 'react';
import type { BoardShape } from './whiteboard_scene';
import { WhiteboardShape } from './WhiteboardShape';

/** An eraser affects only earlier paint in this layer; later paint remains visible. */
export function WhiteboardLayerArt({ shapes }: { shapes: BoardShape[] }) {
  const prefix = useId();
  let art: ReactNode[] = [];
  for (const shape of shapes.filter(s => !s.hidden)) {
    if (shape.tool === 'eraser') {
      const id = `${prefix}-${shape.id}`;
      art = [<g key={shape.id}>
        <defs><mask id={id} maskUnits="userSpaceOnUse" x={-16000} y={-10000} width={48000} height={30000}>
          <rect x={-16000} y={-10000} width={48000} height={30000} fill="white" />
          <WhiteboardShape shape={{ ...shape, color: '#000000' }} />
        </mask></defs><g mask={`url(#${id})`}>{art}</g>
      </g>];
    } else art.push(<WhiteboardShape key={shape.id} shape={shape} />);
  }
  return <>{art}</>;
}
