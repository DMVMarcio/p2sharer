import { useId, useState } from 'react';
import {
  Brush, Pencil, Pen, Eraser, MousePointer2, Square, Circle, Minus, ImagePlus,
  Undo2, Redo2, ChevronDown, PaintBucket, Pipette, Type, BoxSelect, Lasso,
  Wand2, Blend, Sparkles, Droplets, Highlighter, Grid3x3, Flame, FlipHorizontal,
  Trash2, CheckSquare, SquareDashedMousePointer,
} from 'lucide-react';
import { CollapsibleRegion } from '../components/common/CollapsibleRegion';
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
}) {
  const menu = useContextMenu();
  const [open, setOpen] = useState(true);
  const [lastSelectionTool, setLastSelectionTool] = useState<SelectionToolKind>('selectRect');
  const shapeFilled = settings.shapeFilled ?? { rectangle: false, ellipse: false };
  const contentId = useId();

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

  const colors = [
    ['#a47754', 'color.brown'],
    ['#ef4444', 'message.6741b8b5e1c2'],
    ['#f97316', 'message.2b2b4ad00333'],
    ['#facc15', 'message.1875203bcdcc'],
    ['#22c55e', 'message.40598e1cb1d2'],
    ['#06b6d4', 'message.c954e4de2019'],
    ['#3b82f6', 'message.b0bf526b23af'],
    ['#a855f7', 'message.57a73ede5f6f'],
    ['#ec4899', 'message.75f9577a1637'],
    ['#ffffff', 'message.3683a74222dd'],
    ['#000000', 'message.4b652af43d8d'],
  ];

  const showBrushSliders = settings.tool === 'brush' || settings.tool === 'eraser';
  const showShapeSliders = settings.tool === 'rectangle' || settings.tool === 'ellipse' || settings.tool === 'line';
  const showBucketSliders = settings.tool === 'bucket' || settings.tool === 'wand';
  const showGradientSliders = settings.tool === 'gradient';
  const showTextSliders = settings.tool === 'text';

  return (
    <div className={`whiteboard-toolbar ${open ? '' : 'is-collapsed'}`} role="toolbar" aria-label={t('whiteboard.tools')}>
      <div className="whiteboard-toolbar-main-row">
        <div className="whiteboard-toolbar-history" inert={!open || undefined} aria-hidden={!open || undefined}>
          <TooltipButton
            aria-label={t('message.786b48222848')}
            aria-keyshortcuts="Control+Z"
            tooltip={`${t('message.786b48222848')} (Ctrl+Z)`}
            className="room-app-notepad-tool"
            disabled={!canUndo}
            onClick={onUndo}
          >
            <Undo2 size={17} />
          </TooltipButton>
          <TooltipButton
            aria-label={t('message.7b659c9caa5e')}
            aria-keyshortcuts="Control+Y"
            tooltip={`${t('message.7b659c9caa5e')} (Ctrl+Y)`}
            className="room-app-notepad-tool"
            disabled={!canRedo}
            onClick={onRedo}
          >
            <Redo2 size={17} />
          </TooltipButton>
        </div>

        <div className="whiteboard-tool-choices" inert={!open || undefined} aria-hidden={!open || undefined}>
          {tools.map(([toolKey, Icon, shortcut]) => {
            const isSelGroup = toolKey === 'selection';
            const actualTool: BoardTool = isSelGroup ? currentSelectionKind : (toolKey as BoardTool);
            const active = isSelGroup ? isSelectionTool(settings.tool) : settings.tool === actualTool;
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
                className={`room-app-notepad-tool ${active ? 'active' : ''}`}
                onClick={event => {
                  if (isSelGroup) {
                    onChange({ ...settings, tool: currentSelectionKind });
                    menu(
                      event,
                      selectionVariants.map(([selKind, SelIcon, labelKey]) => ({
                        id: `sel-${selKind}`,
                        label: t(labelKey),
                        tooltip: t(labelKey),
                        iconOnly: true,
                        selected: currentSelectionKind === selKind,
                        icon: <SelIcon size={18} strokeWidth={1.8} />,
                        onSelect: () => {
                          setLastSelectionTool(selKind);
                          onChange({ ...settings, tool: selKind });
                        },
                      })),
                      { toggle: true, layout: 'grid', placement: 'top-center' },
                    );
                  } else if (toolKey === 'brush') {
                    const currentBrush = activeBrush[0];
                    onChange({ ...settings, tool: 'brush', brushType: currentBrush });
                    menu(
                      event,
                      brushVariants.map(([brushType, VariantIcon, labelKey]) => ({
                        id: `brush-${brushType}`,
                        label: t(labelKey),
                        tooltip: t(labelKey),
                        iconOnly: true,
                        selected: currentBrush === brushType,
                        icon: <VariantIcon size={18} strokeWidth={1.8} />,
                        onSelect: () => onChange({ ...settings, tool: 'brush', brushType }),
                      })),
                      { toggle: true, layout: 'grid', placement: 'top-center' },
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
                      { toggle: true, layout: 'grid', placement: 'top-center' },
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
                      { toggle: true, placement: 'top-center' },
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
            className={`room-app-notepad-tool ${settings.symmetry && settings.symmetry !== 'none' ? 'active' : ''}`}
            onClick={event =>
              menu(
                event,
                symmetryVariants.map(([mode, labelKey]) => ({
                  id: `sym-${mode}`,
                  label: t(labelKey),
                  selected: (settings.symmetry ?? 'none') === mode,
                  onSelect: () => onChange({ ...settings, symmetry: mode }),
                })),
                { toggle: true, placement: 'top-center' },
              )
            }
          >
            <FlipHorizontal size={18} />
          </TooltipButton>

          {onPasteImage && (
            <TooltipButton tooltip={t('whiteboard.pasteImage')} className="room-app-notepad-tool" onClick={onPasteImage}>
              <ImagePlus size={18} />
            </TooltipButton>
          )}

          <TooltipButton
            tooltip={t('message.2237b88f398f')}
            className="room-app-notepad-tool"
            onClick={event =>
              menu(
                event,
                colors.map(([color, label]) => ({
                  id: color,
                  label: t(label),
                  selected: color === settings.color,
                  icon: <span className="stream-drawing-swatch" style={{ background: color }} />,
                  onSelect: () => onChange({ ...settings, color }),
                })),
                { toggle: true },
              )
            }
          >
            <span className="stream-drawing-swatch" style={{ background: settings.color }} />
          </TooltipButton>

          {(isSelectionTool(settings.tool) || hasSelection) && (
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

        <TooltipButton
          tooltip={t(open ? 'whiteboard.hideTools' : 'whiteboard.showTools')}
          className="room-app-notepad-tool whiteboard-toolbar-toggle"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen(value => !value)}
        >
          <ChevronDown size={20} strokeWidth={2.5} className={open ? '' : 'is-reversed'} />
        </TooltipButton>
      </div>

      <CollapsibleRegion open={open} id={contentId}>
        <div className="whiteboard-tool-properties">
          <IntegerSlider
            label={t('whiteboard.width')}
            min={1}
            max={100}
            value={settings.width}
            onChange={width => onChange({ ...settings, width })}
          />
          <IntegerSlider
            label={t('whiteboard.opacity')}
            min={1}
            max={100}
            value={settings.opacity}
            onChange={opacity => onChange({ ...settings, opacity })}
          />
          {showBrushSliders && (
            <>
              <IntegerSlider
                label={t('whiteboard.hardness')}
                min={0}
                max={100}
                value={settings.hardness ?? 80}
                onChange={hardness => onChange({ ...settings, hardness })}
              />
              <IntegerSlider
                label={t('whiteboard.flow')}
                min={1}
                max={100}
                value={settings.flow ?? 100}
                onChange={flow => onChange({ ...settings, flow })}
              />
            </>
          )}
          {(showBrushSliders || showShapeSliders || settings.tool === 'pointer') && (
            <IntegerSlider
              label={t('whiteboard.smoothing')}
              min={0}
              max={100}
              value={settings.smoothing}
              onChange={smoothing => onChange({ ...settings, smoothing })}
            />
          )}
          {showBucketSliders && (
            <>
              <IntegerSlider
                label={t('whiteboard.tolerance')}
                min={0}
                max={255}
                value={settings.fillTolerance ?? 32}
                onChange={fillTolerance => onChange({ ...settings, fillTolerance })}
              />
              {settings.tool === 'bucket' && (
                <IntegerSlider
                  label={t('whiteboard.fillExpand')}
                  min={-10}
                  max={20}
                  value={settings.fillExpand ?? 1}
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
            <IntegerSlider
              label={t('whiteboard.fontSize')}
              min={8}
              max={160}
              value={settings.fontSize ?? 28}
              onChange={fontSize => onChange({ ...settings, fontSize })}
            />
          )}
        </div>
      </CollapsibleRegion>
    </div>
  );
}
