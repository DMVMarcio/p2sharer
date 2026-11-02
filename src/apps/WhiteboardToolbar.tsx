import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Brush, Pencil, Pen, Eraser, MousePointer2, Square, Circle, Minus, ImagePlus,
  Undo2, Redo2, PaintBucket, Pipette, Type, BoxSelect, Lasso,
  Wand2, Blend, Sparkles, Droplets, Highlighter, Grid3x3, Flame, FlipHorizontal,
  Trash2, CheckSquare, SquareDashedMousePointer, ChevronDown,
} from 'lucide-react';
import { TooltipButton } from '../components/common/TooltipButton';
import { useContextMenu } from '../components/common/ContextMenu';
import { IntegerSlider } from '../components/common/IntegerSlider';
import { t } from '../i18n';
import type { BoardBrushType, BoardSymmetryMode, BoardTool } from './whiteboard_scene';

export interface BoardSettings {
  tool: BoardTool;
  brushType: BoardBrushType;
  color: string;
  secondaryColor?: string;
  width: number;
  opacity: number;
  flow?: number;
  hardness?: number;
  spacing?: number;
  pressureSize?: boolean;
  pressureOpacity?: boolean;
  filled: boolean;
  shapeFilled?: { rectangle: boolean; ellipse: boolean };
  smoothing: number;
  symmetry?: BoardSymmetryMode;
  fillTolerance?: number;
  fillExpand?: number;
  fillContiguous?: boolean;
  fillAntiAlias?: boolean;
  fillSample?: 'layer' | 'all';
  gradientType?: 'linear' | 'radial';
  gradientTransparent?: boolean;
  fontSize?: number;
  fontBold?: boolean;
  fontItalic?: boolean;
}

const SELECTION_TOOLS = ['selectRect', 'selectEllipse', 'lasso', 'wand'] as const;
type SelectionToolKind = (typeof SELECTION_TOOLS)[number];
const isSelectionTool = (tool: BoardTool): tool is SelectionToolKind =>
  (SELECTION_TOOLS as readonly string[]).includes(tool);

function DropdownSlider({
  id,
  label,
  min,
  max,
  value,
  unit = '',
  openId,
  onToggle,
  onChange,
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  value: number;
  unit?: string;
  openId: string | null;
  onToggle(id: string): void;
  onChange(value: number): void;
}) {
  const isOpen = openId === id;
  return (
    <div className={`whiteboard-slider-dropdown ${isOpen ? 'is-open' : ''}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        className={`whiteboard-slider-pill ${isOpen ? 'active' : ''}`}
        onClick={() => onToggle(id)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle(id);
          } else if (e.key === 'Escape' && isOpen) {
            e.preventDefault();
            onToggle(id);
          }
        }}
      >
        <span className="whiteboard-slider-pill-label">{label}:</span>
        <strong className="whiteboard-slider-pill-value">{value}{unit}</strong>
        <ChevronDown size={11} className="whiteboard-slider-pill-chevron" />
      </div>
      <div
        className={`whiteboard-slider-popover ${isOpen ? 'is-open' : ''}`}
        onPointerDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
      >
        <IntegerSlider label={label} min={min} max={max} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

export function WhiteboardToolbar({
  settings,
  onChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onPasteImage,
  hasSelection = false,
  onSelectAll,
  onClearSelection,
  onInvertSelection,
  onDeleteSelectionPixels,
  onFillSelectionPixels,
  fileActions,
  fileStatus,
  boardDimensions,
  altHeld = false,
}: {
  settings: BoardSettings;
  onChange(settings: BoardSettings): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onPasteImage?(): void;
  hasSelection?: boolean;
  onSelectAll?(): void;
  onClearSelection?(): void;
  onInvertSelection?(): void;
  onDeleteSelectionPixels?(): void;
  onFillSelectionPixels?(): void;
  fileActions?: ReactNode;
  fileStatus?: ReactNode;
  boardDimensions?: string;
  altHeld?: boolean;
}) {
  const menu = useContextMenu();
  const [lastSelectionTool, setLastSelectionTool] = useState<SelectionToolKind>('selectRect');
  const [openSlider, setOpenSlider] = useState<string | null>(null);
  const propsRef = useRef<HTMLDivElement>(null);
  const shapeFilled = settings.shapeFilled ?? { rectangle: false, ellipse: false };
  const effectiveTool: BoardTool = altHeld ? 'eyedropper' : settings.tool;

  useEffect(() => {
    if (!openSlider) return;
    const onPointerDown = (event: PointerEvent) => {
      if (propsRef.current && event.target instanceof Node && !propsRef.current.contains(event.target)) {
        setOpenSlider(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenSlider(null);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [openSlider]);

  const toggleSlider = (id: string) => setOpenSlider(prev => (prev === id ? null : id));

  const brushVariants = [
    ['pencil', Pencil, 'whiteboard.pencil'],
    ['pen', Pen, 'whiteboard.pen'],
    ['brush', Brush, 'whiteboard.brush'],
    ['airbrush', Sparkles, 'whiteboard.brushAirbrush'],
    ['watercolor', Droplets, 'whiteboard.brushWatercolor'],
    ['marker', Highlighter, 'whiteboard.brushMarker'],
    ['pixel', Grid3x3, 'whiteboard.brushPixel'],
    ['smudge', Flame, 'whiteboard.brushSmudge'],
    ['blur', Blend, 'whiteboard.brushBlur'],
  ] as const;

  const selectionVariants = [
    ['selectRect', BoxSelect, 'whiteboard.selectRect'],
    ['selectEllipse', Circle, 'whiteboard.selectEllipse'],
    ['lasso', Lasso, 'whiteboard.lasso'],
    ['wand', Wand2, 'whiteboard.wand'],
  ] as const;

  const symmetryVariants: ReadonlyArray<readonly [BoardSymmetryMode, string]> = [
    ['none', 'whiteboard.symmetryNone'],
    ['vertical', 'whiteboard.symmetryVertical'],
    ['horizontal', 'whiteboard.symmetryHorizontal'],
    ['quad', 'whiteboard.symmetryQuad'],
    ['radial', 'whiteboard.symmetryRadial'],
  ];

  const activeBrush = brushVariants.find(([kind]) => kind === settings.brushType) ?? brushVariants[0];
  const ActiveBrushIcon = activeBrush[1];
  const activeBrushLabel = activeBrush[2];

  const currentSelectionKind: SelectionToolKind = isSelectionTool(settings.tool) ? settings.tool : lastSelectionTool;
  const activeSelectionVariant = selectionVariants.find(([kind]) => kind === currentSelectionKind) ?? selectionVariants[0];
  const ActiveSelectionIcon = activeSelectionVariant[1];
  const activeSelectionLabel = activeSelectionVariant[2];

  const tools = [
    ['pointer', MousePointer2, 'V'],
    ['selection', ActiveSelectionIcon, 'M'],
    ['brush', ActiveBrushIcon, 'B'],
    ['eraser', Eraser, 'E'],
    ['bucket', PaintBucket, 'G'],
    ['gradient', Blend, 'K'],
    ['rectangle', Square, 'R'],
    ['ellipse', Circle, 'O'],
    ['line', Minus, 'L'],
    ['text', Type, 'T'],
    ['eyedropper', Pipette, 'I'],
  ] as const;

  const showBrushSliders = settings.tool === 'brush' || settings.tool === 'eraser';
  const showShapeSliders = settings.tool === 'rectangle' || settings.tool === 'ellipse' || settings.tool === 'line';
  const showBucketSliders = settings.tool === 'bucket' || settings.tool === 'wand';
  const showGradientSliders = settings.tool === 'gradient';
  const showTextSliders = settings.tool === 'text';

  return (
    <div className="whiteboard-studio-chrome" role="toolbar" aria-label={t('whiteboard.tools')}>
      <div className="whiteboard-toolbar-main-row">
        <div className="whiteboard-toolbar-history">
          <TooltipButton
            aria-label={t('message.786b48222848')}
            aria-keyshortcuts="Control+Z"
            tooltip={`${t('message.786b48222848')} (Ctrl+Z)`}
            className="room-app-notepad-tool"
            disabled={!canUndo}
            onClick={onUndo}
          >
            <Undo2 size={16} />
          </TooltipButton>
          <TooltipButton
            aria-label={t('message.7b659c9caa5e')}
            aria-keyshortcuts="Control+Y"
            tooltip={`${t('message.7b659c9caa5e')} (Ctrl+Y)`}
            className="room-app-notepad-tool"
            disabled={!canRedo}
            onClick={onRedo}
          >
            <Redo2 size={16} />
          </TooltipButton>
        </div>
      </div>

      <div ref={propsRef} className="whiteboard-tool-properties">
        <div className="whiteboard-brush-preview-card" aria-hidden="true">
          <div className="whiteboard-brush-preview-stage">
            <span
              className={`whiteboard-brush-preview-dot ${settings.tool === 'brush' && (settings.brushType === 'pixel' || settings.brushType === 'marker') ? 'is-square' : ''}`}
              style={{
                width: `${Math.max(3, Math.min(26, settings.width * 0.34))}px`,
                height: `${Math.max(3, Math.min(26, settings.width * 0.34))}px`,
                backgroundColor: settings.tool === 'eraser' ? 'transparent' : settings.color,
                border: settings.tool === 'eraser' ? '1.5px dashed var(--text-secondary)' : 'none',
                opacity: Math.max(0.15, (settings.opacity ?? 100) / 100),
                filter: showBrushSliders && (settings.hardness ?? 80) < 70
                  ? `blur(${Math.round(((70 - (settings.hardness ?? 80)) / 70) * 3 * 10) / 10}px)`
                  : undefined,
              }}
            />
          </div>
          <div className="whiteboard-brush-preview-meta">
            <span className="whiteboard-brush-preview-title">
              {t(
                effectiveTool === 'brush'
                  ? activeBrushLabel
                  : isSelectionTool(effectiveTool)
                    ? activeSelectionLabel
                    : `whiteboard.${effectiveTool}`,
              )}
            </span>
          </div>
        </div>
        <DropdownSlider
          id="width"
          label={t('whiteboard.width')}
          min={1}
          max={100}
          value={settings.width}
          unit="px"
          openId={openSlider}
          onToggle={toggleSlider}
          onChange={width => onChange({ ...settings, width })}
        />
        <DropdownSlider
          id="opacity"
          label={t('whiteboard.opacity')}
          min={1}
          max={100}
          value={settings.opacity}
          unit="%"
          openId={openSlider}
          onToggle={toggleSlider}
          onChange={opacity => onChange({ ...settings, opacity })}
        />
        {showBrushSliders && (
          <>
            <DropdownSlider
              id="hardness"
              label={t('whiteboard.hardness')}
              min={0}
              max={100}
              value={settings.hardness ?? 80}
              unit="%"
              openId={openSlider}
              onToggle={toggleSlider}
              onChange={hardness => onChange({ ...settings, hardness })}
            />
            <DropdownSlider
              id="flow"
              label={t('whiteboard.flow')}
              min={1}
              max={100}
              value={settings.flow ?? 100}
              unit="%"
              openId={openSlider}
              onToggle={toggleSlider}
              onChange={flow => onChange({ ...settings, flow })}
            />
          </>
        )}
        {(showBrushSliders || showShapeSliders || settings.tool === 'pointer') && (
          <DropdownSlider
            id="smoothing"
            label={t('whiteboard.smoothing')}
            min={0}
            max={100}
            value={settings.smoothing}
            unit="%"
            openId={openSlider}
            onToggle={toggleSlider}
            onChange={smoothing => onChange({ ...settings, smoothing })}
          />
        )}
        {showBucketSliders && (
          <>
            <DropdownSlider
              id="tolerance"
              label={t('whiteboard.tolerance')}
              min={0}
              max={255}
              value={settings.fillTolerance ?? 32}
              openId={openSlider}
              onToggle={toggleSlider}
              onChange={fillTolerance => onChange({ ...settings, fillTolerance })}
            />
            {settings.tool === 'bucket' && (
              <DropdownSlider
                id="fillExpand"
                label={t('whiteboard.fillExpand')}
                min={-10}
                max={20}
                value={settings.fillExpand ?? 1}
                unit="px"
                openId={openSlider}
                onToggle={toggleSlider}
                onChange={fillExpand => onChange({ ...settings, fillExpand })}
              />
            )}
            <label className="whiteboard-inline-switch">
              <input
                autoComplete="off"
                type="checkbox"
                checked={settings.fillContiguous !== false}
                onChange={e => onChange({ ...settings, fillContiguous: e.target.checked })}
              />
              <span>{t('whiteboard.fillContiguous')}</span>
            </label>
            <label className="whiteboard-inline-switch">
              <input
                autoComplete="off"
                type="checkbox"
                checked={settings.fillSample === 'all'}
                onChange={e => onChange({ ...settings, fillSample: e.target.checked ? 'all' : 'layer' })}
              />
              <span>{t('whiteboard.fillSampleAll')}</span>
            </label>
          </>
        )}
        {showGradientSliders && (
          <label className="whiteboard-inline-switch">
            <input
              autoComplete="off"
              type="checkbox"
              checked={Boolean(settings.gradientTransparent)}
              onChange={e => onChange({ ...settings, gradientTransparent: e.target.checked })}
            />
            <span>{t('whiteboard.gradientTransparent')}</span>
          </label>
        )}
        {showTextSliders && (
          <DropdownSlider
            id="fontSize"
            label={t('whiteboard.fontSize')}
            min={8}
            max={160}
            value={settings.fontSize ?? 28}
            unit="px"
            openId={openSlider}
            onToggle={toggleSlider}
            onChange={fontSize => onChange({ ...settings, fontSize })}
          />
        )}
      </div>

      <div className="whiteboard-toolbar">
        <div className="whiteboard-tool-choices">
          {tools.map(([toolKey, Icon, shortcut]) => {
            const isSelGroup = toolKey === 'selection';
            const actualTool: BoardTool = isSelGroup ? currentSelectionKind : (toolKey as BoardTool);
            const active = isSelGroup ? isSelectionTool(effectiveTool) : effectiveTool === actualTool;
            const hasFlyout = isSelGroup || toolKey === 'brush' || toolKey === 'rectangle' || toolKey === 'ellipse' || toolKey === 'gradient';
            const baseLabel = t(
              toolKey === 'brush'
                ? activeBrushLabel
                : isSelGroup
                  ? activeSelectionLabel
                  : `whiteboard.${toolKey}`,
            );
            return (
              <TooltipButton
                key={toolKey}
                aria-label={baseLabel}
                aria-keyshortcuts={shortcut}
                tooltip={`${baseLabel} (${shortcut})`}
                aria-pressed={active}
                className={`room-app-notepad-tool ${active ? 'active' : ''} ${hasFlyout ? 'has-flyout' : ''}`}
                onClick={event => {
                  if (isSelGroup) {
                    onChange({ ...settings, tool: currentSelectionKind });
                    menu(
                      event,
                      selectionVariants.map(([selKind, SelIcon, labelKey]) => ({
                        id: `sel-${selKind}`,
                        label: t(labelKey),
                        selected: currentSelectionKind === selKind,
                        icon: <SelIcon size={17} strokeWidth={1.8} />,
                        onSelect: () => {
                          setLastSelectionTool(selKind);
                          onChange({ ...settings, tool: selKind });
                        },
                      })),
                      { toggle: true, placement: 'right-start' },
                    );
                  } else if (toolKey === 'brush') {
                    const currentBrush = activeBrush[0];
                    onChange({ ...settings, tool: 'brush', brushType: currentBrush });
                    menu(
                      event,
                      brushVariants.map(([brushType, VariantIcon, labelKey]) => ({
                        id: `brush-${brushType}`,
                        label: t(labelKey),
                        selected: currentBrush === brushType,
                        icon: <VariantIcon size={17} strokeWidth={1.8} />,
                        onSelect: () => onChange({ ...settings, tool: 'brush', brushType }),
                      })),
                      { toggle: true, placement: 'right-start' },
                    );
                  } else if (toolKey === 'rectangle' || toolKey === 'ellipse') {
                    const currentFilled = shapeFilled[toolKey];
                    onChange({ ...settings, tool: toolKey, filled: currentFilled });
                    menu(
                      event,
                      [false, true].map(filled => ({
                        id: `${toolKey}-${filled}`,
                        label: t(filled ? 'whiteboard.filled' : 'whiteboard.outline'),
                        tooltip: t(filled ? 'whiteboard.filled' : 'whiteboard.outline'),
                        iconOnly: true,
                        selected: currentFilled === filled,
                        icon: <Icon size={18} fill={filled ? 'currentColor' : 'none'} strokeWidth={1.8} />,
                        onSelect: () => {
                          const nextShapeFilled = { ...shapeFilled, [toolKey]: filled };
                          onChange({ ...settings, tool: toolKey, filled, shapeFilled: nextShapeFilled });
                        },
                      })),
                      { toggle: true, layout: 'grid', placement: 'right-start' },
                    );
                  } else if (toolKey === 'gradient') {
                    const currentGrad = settings.gradientType ?? 'linear';
                    onChange({ ...settings, tool: 'gradient', gradientType: currentGrad });
                    menu(
                      event,
                      ([
                        ['linear', 'whiteboard.gradient'],
                        ['radial', 'whiteboard.gradientRadial'],
                      ] as const).map(([gradientType, labelKey]) => ({
                        id: `gradient-${gradientType}`,
                        label: t(labelKey),
                        selected: currentGrad === gradientType,
                        onSelect: () => onChange({ ...settings, tool: 'gradient', gradientType }),
                      })),
                      { toggle: true, placement: 'right-start' },
                    );
                  } else {
                    onChange({ ...settings, tool: actualTool });
                  }
                }}
              >
                <Icon
                  size={18}
                  fill={
                    (toolKey === 'rectangle' || toolKey === 'ellipse') &&
                    (settings.tool === toolKey ? settings.filled : shapeFilled[toolKey])
                      ? 'currentColor'
                      : 'none'
                  }
                />
              </TooltipButton>
            );
          })}

          <TooltipButton
            tooltip={t('whiteboard.symmetry')}
            aria-label={t('whiteboard.symmetry')}
            aria-pressed={Boolean(settings.symmetry && settings.symmetry !== 'none')}
            className={`room-app-notepad-tool has-flyout ${settings.symmetry && settings.symmetry !== 'none' ? 'active' : ''}`}
            onClick={event =>
              menu(
                event,
                symmetryVariants.map(([mode, labelKey]) => ({
                  id: `sym-${mode}`,
                  label: t(labelKey),
                  selected: (settings.symmetry ?? 'none') === mode,
                  onSelect: () => onChange({ ...settings, symmetry: mode }),
                })),
                { toggle: true, placement: 'right-start' },
              )
            }
          >
            <FlipHorizontal size={18} />
          </TooltipButton>

          {onPasteImage && (
            <TooltipButton tooltip={t('whiteboard.pasteImage')} aria-label={t('whiteboard.pasteImage')} className="room-app-notepad-tool" onClick={onPasteImage}>
              <ImagePlus size={18} />
            </TooltipButton>
          )}

          {(isSelectionTool(effectiveTool) || hasSelection) && (
            <div className="whiteboard-selection-quick-actions">
              {onSelectAll && (
                <TooltipButton
                  tooltip={`${t('whiteboard.selectAll')} (Ctrl+A)`}
                  aria-label={t('whiteboard.selectAll')}
                  className="room-app-notepad-tool"
                  onClick={onSelectAll}
                >
                  <CheckSquare size={16} />
                </TooltipButton>
              )}
              {hasSelection && onInvertSelection && (
                <TooltipButton
                  tooltip={`${t('whiteboard.invertSelection')} (Ctrl+Shift+I)`}
                  aria-label={t('whiteboard.invertSelection')}
                  className="room-app-notepad-tool"
                  onClick={onInvertSelection}
                >
                  <SquareDashedMousePointer size={16} />
                </TooltipButton>
              )}
              {hasSelection && onFillSelectionPixels && (
                <TooltipButton
                  tooltip={t('whiteboard.fillSelection')}
                  aria-label={t('whiteboard.fillSelection')}
                  className="room-app-notepad-tool"
                  onClick={onFillSelectionPixels}
                >
                  <PaintBucket size={16} />
                </TooltipButton>
              )}
              {hasSelection && onDeleteSelectionPixels && (
                <TooltipButton
                  tooltip={`${t('whiteboard.clearSelection')} (Del)`}
                  aria-label={t('whiteboard.clearSelection')}
                  className="room-app-notepad-tool"
                  onClick={onDeleteSelectionPixels}
                >
                  <Trash2 size={16} />
                </TooltipButton>
              )}
              {hasSelection && onClearSelection && (
                <TooltipButton
                  tooltip={`${t('whiteboard.deselect')} (Ctrl+D)`}
                  aria-label={t('whiteboard.deselect')}
                  className="room-app-notepad-tool"
                  onClick={onClearSelection}
                >
                  <Square size={15} />
                </TooltipButton>
              )}
            </div>
          )}
        </div>
      </div>

      {(fileActions || fileStatus || boardDimensions) && (
        <div
          className="whiteboard-bottom-left-hud"
          onPointerDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          {fileActions}
          {fileStatus}
          {boardDimensions && <span className="whiteboard-canvas-dims">{boardDimensions}</span>}
        </div>
      )}
    </div>
  );
}
