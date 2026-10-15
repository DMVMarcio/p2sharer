import { ArrowUp, ArrowDown, Eye, EyeOff, Lock, Unlock, Trash2 } from 'lucide-react';
import { TooltipButton } from '../components/common/TooltipButton';
import { t } from '../i18n';
import type { BoardShape } from './whiteboard_scene';

export function WhiteboardLayers({ shapes, selected, onSelect, onChange, onDelete }: {
  shapes: BoardShape[]; selected: string | null; onSelect(id: string): void; onChange(shape: BoardShape): void; onDelete(id: string): void;
}) {
  const reorder = (shape: BoardShape, direction: number) => {
    const index = shapes.findIndex(s => s.id === shape.id), other = index + direction;
    if (!shapes[other]) return;
    // Fractional ordering changes only the moved object, preserving concurrent edits to other layers.
    const order = direction > 0 ? (shapes[other + 1] ? (shapes[other].order + shapes[other + 1].order) / 2 : shapes[other].order + 1)
      : (shapes[other - 1] ? (shapes[other].order + shapes[other - 1].order) / 2 : shapes[other].order - 1);
    onChange({ ...shape, order });
  };
  return <aside className="whiteboard-layers" aria-label={t('whiteboard.layers')}>
    <strong>{t('whiteboard.layers')}</strong>
    {!shapes.length && <p>{t('whiteboard.emptyScene')}</p>}
    {[...shapes].reverse().map((shape, index) => <div key={shape.id} className={`whiteboard-layer ${selected === shape.id ? 'selected' : ''}`}>
      <button className="btn btn-sm btn-secondary whiteboard-layer-name" aria-pressed={selected === shape.id} onClick={() => onSelect(shape.id)}>
        <span className="stream-drawing-swatch" style={{ background: shape.color }} />{t(`whiteboard.${shape.tool}`)} {shapes.length - index}</button>
      <div className="room-app-toolbar-actions">
        <TooltipButton tooltip={t('whiteboard.visibility')} className="room-app-notepad-tool" aria-pressed={!shape.hidden} onClick={() => onChange({ ...shape, hidden: !shape.hidden })}>{shape.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</TooltipButton>
        <TooltipButton tooltip={t('whiteboard.lock')} className="room-app-notepad-tool" aria-pressed={shape.locked} onClick={() => onChange({ ...shape, locked: !shape.locked })}>{shape.locked ? <Lock size={14} /> : <Unlock size={14} />}</TooltipButton>
        <TooltipButton tooltip={t('whiteboard.raise')} className="room-app-notepad-tool" disabled={shape.locked || index === 0} onClick={() => reorder(shape, 1)}><ArrowUp size={14} /></TooltipButton>
        <TooltipButton tooltip={t('whiteboard.lower')} className="room-app-notepad-tool" disabled={shape.locked || index === shapes.length - 1} onClick={() => reorder(shape, -1)}><ArrowDown size={14} /></TooltipButton>
        <TooltipButton tooltip={t('whiteboard.delete')} className="room-app-notepad-tool" disabled={shape.locked} onClick={() => onDelete(shape.id)}><Trash2 size={14} /></TooltipButton>
      </div>
    </div>)}
  </aside>;
}
