import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GripVertical, Plus, Pencil, Eye, EyeOff, Lock, Unlock, Trash2, Layers, ChevronRight } from 'lucide-react';
import { CollapsibleRegion } from '../components/common/CollapsibleRegion';
import { TooltipButton } from '../components/common/TooltipButton';
import { useSortableGrid } from '../hooks/useSortableGrid';
import { t } from '../i18n';
import type { BoardLayer, BoardShape } from './whiteboard_scene';
import { WhiteboardLayerPreview } from './WhiteboardLayerPreview';

export function WhiteboardLayers({ layers, shapes, active, onActivate, onChange, onDelete, onAdd, onReorder }: {
  layers: BoardLayer[]; shapes: BoardShape[]; active: string; onActivate(id: string): void; onChange(layer: BoardLayer): void;
  onDelete(id: string): void; onAdd(): void; onReorder(ids: string[]): void;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  const contentId = useId();
  const sorting = useSortableGrid([...layers].reverse().map(l => l.id), ids => onReorder([...ids].reverse()), overlay);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const cancelled = useRef(false);
  const layerName = (layer: BoardLayer) => layer.name || t('whiteboard.layerName', { index: layers.findIndex(l => l.id === layer.id) + 1 });
  const commit = (layer: BoardLayer) => {
    if (!cancelled.current && name.trim()) onChange({ ...layer, name: name.trim() });
    cancelled.current = false; setRenaming(null);
  };
  const dragging = layers.find(l => l.id === sorting.draggingId);
  return <aside className={`whiteboard-layers ${open ? '' : 'is-collapsed'}`} aria-label={t('whiteboard.layers')}>
    <TooltipButton tooltip={t(open ? 'whiteboard.hideLayers' : 'whiteboard.showLayers')} className="room-app-notepad-tool whiteboard-layers-toggle"
      aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(value => !value)}><Layers size={16} /><ChevronRight size={13} className={open ? '' : 'is-reversed'} /></TooltipButton>
    <CollapsibleRegion open={open} id={contentId}>
    <div className="whiteboard-layer-header"><strong>{t('whiteboard.layers')}</strong>
      <TooltipButton tooltip={t('whiteboard.addLayer')} className="room-app-notepad-tool" disabled={layers.length >= 64} onClick={onAdd}><Plus size={16} /></TooltipButton></div>
    <div ref={sorting.gridRef} className="whiteboard-layer-list">
    {sorting.order.map(id => {
      const layer = layers.find(l => l.id === id); if (!layer) return null;
      return <div ref={sorting.cardRef(id)} data-sortable-id={id} key={id}
        onClick={event => { if (!(event.target as HTMLElement).closest('button, input')) onActivate(id); }}
        className={`whiteboard-layer ${active === id ? 'selected' : ''} ${sorting.draggingId === id ? 'is-dragging' : ''}`}>
        <TooltipButton className="whiteboard-layer-select" tooltip={t('whiteboard.selectLayer', { name: layerName(layer) })}
          aria-pressed={active === id} onClick={() => onActivate(id)}><WhiteboardLayerPreview shapes={shapes} layer={layer} /></TooltipButton>
        <div className="whiteboard-layer-body">
          {renaming === id ? <input autoComplete="off" autoFocus className="text-input-sm whiteboard-layer-name-input" aria-label={t('whiteboard.renameLayer')} value={name} maxLength={80}
            onChange={event => setName(event.target.value)} onBlur={() => commit(layer)} onKeyDown={event => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') { cancelled.current = true; event.currentTarget.blur(); }
            }} /> : <TooltipButton className="whiteboard-layer-name" tooltip={t('whiteboard.renameLayer')}
            onClick={() => { onActivate(id); setName(layerName(layer)); setRenaming(id); }}><span>{layerName(layer)}</span><Pencil size={12} /></TooltipButton>}
          <div className="room-app-toolbar-actions">
            <TooltipButton tooltip={t('whiteboard.visibility')} className="room-app-notepad-tool" aria-pressed={!layer.hidden} onClick={() => onChange({ ...layer, hidden: !layer.hidden })}>{layer.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</TooltipButton>
            <TooltipButton tooltip={t('whiteboard.lock')} className="room-app-notepad-tool" aria-pressed={layer.locked} onClick={() => onChange({ ...layer, locked: !layer.locked })}>{layer.locked ? <Lock size={14} /> : <Unlock size={14} />}</TooltipButton>
            <TooltipButton tooltip={t('whiteboard.delete')} className="room-app-notepad-tool" disabled={layer.locked || layers.length <= 1} onClick={() => onDelete(id)}><Trash2 size={14} /></TooltipButton>
          </div>
        </div>
        <TooltipButton tooltip={t('whiteboard.reorderLayer')} className="room-app-notepad-tool whiteboard-layer-handle" {...sorting.handleProps(id)}><GripVertical size={17} /></TooltipButton>
      </div>;
    })}
    </div>
    </CollapsibleRegion>
    {dragging && createPortal(<div ref={overlay} className="whiteboard-layer whiteboard-layer-drag" aria-hidden="true">{layerName(dragging)}</div>, document.fullscreenElement ?? document.body)}
  </aside>;
}
