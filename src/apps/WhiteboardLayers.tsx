import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  GripVertical, Plus, Pencil, Eye, EyeOff, Lock, Unlock, Trash2, Layers, ChevronRight,
  Copy, Merge, Eraser, CornerDownRight, Grid2x2Check, FlipHorizontal2, FlipVertical2,
} from 'lucide-react';
import { CollapsibleRegion } from '../components/common/CollapsibleRegion';
import { IntegerSlider } from '../components/common/IntegerSlider';
import { Select } from '../components/common/Select';
import { TooltipButton } from '../components/common/TooltipButton';
import { useSortableGrid } from '../hooks/useSortableGrid';
import { t } from '../i18n';
import { BOARD_BLEND_MODES, type BoardBlendMode, type BoardLayer, type BoardShape } from './whiteboard_scene';
import { WhiteboardColorPanel } from './WhiteboardColorPanel';
import { WhiteboardLayerPreview } from './WhiteboardLayerPreview';

export function WhiteboardLayers({
  layers,
  shapes,
  active,
  onActivate,
  onChange,
  onDelete,
  onAdd,
  onDuplicate,
  onMergeDown,
  onClearLayer,
  onFlipLayer,
  onReorder,
  imageHref,
  color,
  secondaryColor,
  recentColors,
  isEyedropper,
  onColorChange,
  onSecondaryColorChange,
  onCommitColor,
  onSwapColors,
  onResetColors,
  onPickEyedropper,
}: {
  layers: BoardLayer[];
  shapes: BoardShape[];
  active: string;
  onActivate(id: string): void;
  onChange(layer: BoardLayer): void;
  onDelete(id: string): void;
  onAdd(): void;
  onDuplicate?(id: string): void;
  onMergeDown?(id: string): void;
  onClearLayer?(id: string): void;
  onFlipLayer?(id: string, axis: 'x' | 'y'): void;
  onReorder(ids: string[]): void;
  imageHref?: (hash: string) => string | undefined;
  color?: string;
  secondaryColor?: string;
  recentColors?: readonly string[];
  isEyedropper?: boolean;
  onColorChange?(color: string): void;
  onSecondaryColorChange?(color: string): void;
  onCommitColor?(color: string): void;
  onSwapColors?(): void;
  onResetColors?(): void;
  onPickEyedropper?(): void;
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
  const activeLayerObj = layers.find(l => l.id === active) ?? layers[0];
  const activeIdx = layers.findIndex(l => l.id === activeLayerObj?.id);
  const canMergeDown = Boolean(activeLayerObj && !activeLayerObj.locked && !activeLayerObj.hidden && activeIdx > 0 && !layers[activeIdx - 1]?.locked && !layers[activeIdx - 1]?.hidden);

  const blendLabelKeys: Record<BoardBlendMode, string> = {
    normal: 'whiteboard.blendNormal',
    multiply: 'whiteboard.blendMultiply',
    screen: 'whiteboard.blendScreen',
    overlay: 'whiteboard.blendOverlay',
    darken: 'whiteboard.blendDarken',
    lighten: 'whiteboard.blendLighten',
    'color-dodge': 'whiteboard.blendColorDodge',
    difference: 'whiteboard.blendDifference',
  };
  const blendOptions = BOARD_BLEND_MODES.map(mode => ({
    value: mode,
    label: t(blendLabelKeys[mode]),
  }));

  return (
    <aside className={`whiteboard-layers ${open ? '' : 'is-collapsed'}`} aria-label={t('whiteboard.layers')}>
      <TooltipButton
        tooltip={t(open ? 'whiteboard.hideLayers' : 'whiteboard.showLayers')}
        className="room-app-notepad-tool whiteboard-layers-toggle"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen(value => !value)}
      >
        <Layers size={16} />
        <ChevronRight size={13} className={open ? '' : 'is-reversed'} />
      </TooltipButton>
      <CollapsibleRegion open={open} id={contentId}>
        {color && onColorChange && (
          <WhiteboardColorPanel
            color={color}
            secondaryColor={secondaryColor ?? '#ffffff'}
            recentColors={recentColors ?? []}
            isEyedropper={Boolean(isEyedropper)}
            onColorChange={onColorChange}
            onSecondaryColorChange={onSecondaryColorChange ?? (() => {})}
            onCommitColor={onCommitColor}
            onSwapColors={onSwapColors ?? (() => {})}
            onResetColors={onResetColors ?? (() => {})}
            onPickEyedropper={onPickEyedropper ?? (() => {})}
          />
        )}

        <div className="whiteboard-layer-header">
          <strong>{t('whiteboard.layers')}</strong>
          <div className="whiteboard-layer-header-actions">
            {onDuplicate && activeLayerObj && (
              <TooltipButton
                tooltip={t('whiteboard.duplicateLayer')}
                aria-label={t('whiteboard.duplicateLayer')}
                aria-disabled={layers.length >= 64 || undefined}
                className={`room-app-notepad-tool ${layers.length >= 64 ? 'is-disabled' : ''}`}
                onClick={() => {
                  if (layers.length < 64) onDuplicate(activeLayerObj.id);
                }}
              >
                <Copy size={14} />
              </TooltipButton>
            )}
            {onMergeDown && activeLayerObj && (
              <TooltipButton
                tooltip={t('whiteboard.mergeDown')}
                aria-label={t('whiteboard.mergeDown')}
                aria-disabled={!canMergeDown || undefined}
                className={`room-app-notepad-tool ${!canMergeDown ? 'is-disabled' : ''}`}
                onClick={() => {
                  if (canMergeDown) onMergeDown(activeLayerObj.id);
                }}
              >
                <Merge size={14} />
              </TooltipButton>
            )}
            {onClearLayer && activeLayerObj && (
              <TooltipButton
                tooltip={t('whiteboard.clearLayer')}
                aria-label={t('whiteboard.clearLayer')}
                aria-disabled={activeLayerObj.locked || activeLayerObj.hidden || undefined}
                className={`room-app-notepad-tool ${activeLayerObj.locked || activeLayerObj.hidden ? 'is-disabled' : ''}`}
                onClick={() => {
                  if (!activeLayerObj.locked && !activeLayerObj.hidden) onClearLayer(activeLayerObj.id);
                }}
              >
                <Eraser size={14} />
              </TooltipButton>
            )}
            <TooltipButton
              tooltip={t('whiteboard.addLayer')}
              aria-label={t('whiteboard.addLayer')}
              aria-disabled={layers.length >= 64 || undefined}
              className={`room-app-notepad-tool ${layers.length >= 64 ? 'is-disabled' : ''}`}
              onClick={() => {
                if (layers.length < 64) onAdd();
              }}
            >
              <Plus size={16} />
            </TooltipButton>
          </div>
        </div>

        {activeLayerObj && (
          <div className="whiteboard-layer-studio-controls">
            <div className="whiteboard-layer-blend-row">
              <Select
                aria-label={t('whiteboard.blendMode')}
                className="whiteboard-blend-select"
                value={activeLayerObj.blendMode ?? 'normal'}
                options={blendOptions}
                disabled={activeLayerObj.locked}
                onValueChange={val => onChange({ ...activeLayerObj, blendMode: val as BoardBlendMode })}
              />
              <TooltipButton
                tooltip={t('whiteboard.alphaLock')}
                aria-label={t('whiteboard.alphaLock')}
                aria-pressed={Boolean(activeLayerObj.alphaLock)}
                aria-disabled={activeLayerObj.locked || undefined}
                className={`room-app-notepad-tool ${activeLayerObj.alphaLock ? 'active' : ''} ${activeLayerObj.locked ? 'is-disabled' : ''}`}
                onClick={() => {
                  if (!activeLayerObj.locked) onChange({ ...activeLayerObj, alphaLock: !activeLayerObj.alphaLock });
                }}
              >
                <Grid2x2Check size={14} />
              </TooltipButton>
              <TooltipButton
                tooltip={t('whiteboard.clippingMask')}
                aria-label={t('whiteboard.clippingMask')}
                aria-pressed={Boolean(activeLayerObj.clipping)}
                aria-disabled={activeLayerObj.locked || undefined}
                className={`room-app-notepad-tool ${activeLayerObj.clipping ? 'active' : ''} ${activeLayerObj.locked ? 'is-disabled' : ''}`}
                onClick={() => {
                  if (!activeLayerObj.locked) onChange({ ...activeLayerObj, clipping: !activeLayerObj.clipping });
                }}
              >
                <CornerDownRight size={14} />
              </TooltipButton>
              {onFlipLayer && (
                <>
                  <TooltipButton
                    tooltip={t('whiteboard.flipHorizontal')}
                    aria-label={t('whiteboard.flipHorizontal')}
                    aria-disabled={activeLayerObj.locked || activeLayerObj.hidden || undefined}
                    className={`room-app-notepad-tool ${activeLayerObj.locked || activeLayerObj.hidden ? 'is-disabled' : ''}`}
                    onClick={() => {
                      if (!activeLayerObj.locked && !activeLayerObj.hidden) onFlipLayer(activeLayerObj.id, 'x');
                    }}
                  >
                    <FlipHorizontal2 size={14} />
                  </TooltipButton>
                  <TooltipButton
                    tooltip={t('whiteboard.flipVertical')}
                    aria-label={t('whiteboard.flipVertical')}
                    aria-disabled={activeLayerObj.locked || activeLayerObj.hidden || undefined}
                    className={`room-app-notepad-tool ${activeLayerObj.locked || activeLayerObj.hidden ? 'is-disabled' : ''}`}
                    onClick={() => {
                      if (!activeLayerObj.locked && !activeLayerObj.hidden) onFlipLayer(activeLayerObj.id, 'y');
                    }}
                  >
                    <FlipVertical2 size={14} />
                  </TooltipButton>
                </>
              )}
            </div>
            <div className="whiteboard-layer-opacity-row">
              <IntegerSlider
                label={t('whiteboard.layerOpacity')}
                min={0}
                max={100}
                value={activeLayerObj.opacity ?? 100}
                onChange={opacity => {
                  if (!activeLayerObj.locked) onChange({ ...activeLayerObj, opacity });
                }}
              />
            </div>
          </div>
        )}

        <div ref={sorting.gridRef} className="whiteboard-layer-list">
          {sorting.order.map(id => {
            const layer = layers.find(l => l.id === id);
            if (!layer) return null;
            return (
              <div
                ref={sorting.cardRef(id)}
                data-sortable-id={id}
                key={id}
                onClick={event => {
                  if (!(event.target as HTMLElement).closest('button, input')) onActivate(id);
                }}
                className={`whiteboard-layer ${active === id ? 'selected' : ''} ${layer.clipping ? 'is-clipped' : ''} ${sorting.draggingId === id ? 'is-dragging' : ''}`}
              >
                {layer.clipping && <CornerDownRight size={12} className="whiteboard-layer-clip-icon" aria-hidden="true" />}
                <TooltipButton
                  className="whiteboard-layer-select"
                  tooltip={t('whiteboard.selectLayer', { name: layerName(layer) })}
                  aria-pressed={active === id}
                  onClick={() => onActivate(id)}
                >
                  <WhiteboardLayerPreview shapes={shapes} layer={layer} imageHref={imageHref} />
                </TooltipButton>
                <div className="whiteboard-layer-body">
                  {renaming === id ? (
                    <input
                      autoComplete="off"
                      autoFocus
                      className="text-input-sm whiteboard-layer-name-input"
                      aria-label={t('whiteboard.renameLayer')}
                      value={name}
                      maxLength={80}
                      onChange={event => setName(event.target.value)}
                      onBlur={() => commit(layer)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                        if (event.key === 'Escape') { cancelled.current = true; event.currentTarget.blur(); }
                      }}
                    />
                  ) : (
                    <TooltipButton
                      className="whiteboard-layer-name"
                      tooltip={t('whiteboard.renameLayer')}
                      onClick={() => { onActivate(id); setName(layerName(layer)); setRenaming(id); }}
                    >
                      <span>{layerName(layer)}</span>
                      <Pencil size={12} />
                    </TooltipButton>
                  )}
                  <div className="whiteboard-layer-meta-row">
                    <div className="room-app-toolbar-actions">
                      <TooltipButton
                        tooltip={t('whiteboard.visibility')}
                        className="room-app-notepad-tool"
                        aria-pressed={!layer.hidden}
                        onClick={() => onChange({ ...layer, hidden: !layer.hidden })}
                      >
                        {layer.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                      </TooltipButton>
                      <TooltipButton
                        tooltip={t('whiteboard.lock')}
                        className="room-app-notepad-tool"
                        aria-pressed={layer.locked}
                        onClick={() => onChange({ ...layer, locked: !layer.locked })}
                      >
                        {layer.locked ? <Lock size={14} /> : <Unlock size={14} />}
                      </TooltipButton>
                      <TooltipButton
                        tooltip={t('whiteboard.delete')}
                        className="room-app-notepad-tool"
                        disabled={layer.locked || layers.length <= 1}
                        onClick={() => onDelete(id)}
                      >
                        <Trash2 size={14} />
                      </TooltipButton>
                    </div>
                    <span className="whiteboard-layer-badges">
                      {layer.alphaLock && <Grid2x2Check size={11} aria-hidden="true" />}
                      {((layer.opacity ?? 100) < 100 || (layer.blendMode && layer.blendMode !== 'normal')) && (
                        <small>{layer.opacity ?? 100}%</small>
                      )}
                    </span>
                  </div>
                </div>
                <TooltipButton
                  tooltip={t('whiteboard.reorderLayer')}
                  className="room-app-notepad-tool whiteboard-layer-handle"
                  {...sorting.handleProps(id)}
                >
                  <GripVertical size={17} />
                </TooltipButton>
              </div>
            );
          })}
        </div>
      </CollapsibleRegion>
      {dragging && createPortal(
        <div ref={overlay} className="whiteboard-layer whiteboard-layer-drag" aria-hidden="true">
          {layerName(dragging)}
        </div>,
        document.fullscreenElement ?? document.body,
      )}
    </aside>
  );
}
