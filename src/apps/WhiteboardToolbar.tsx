import { useId, useState } from 'react';
import { Brush, Pencil, Pen, Eraser, MousePointer2, Square, Circle, Minus, ImagePlus, Undo2, Redo2, ChevronDown } from 'lucide-react';
import { CollapsibleRegion } from '../components/common/CollapsibleRegion';
import { TooltipButton } from '../components/common/TooltipButton';
import { useContextMenu } from '../components/common/ContextMenu';
import { IntegerSlider } from '../components/common/IntegerSlider';
import { t } from '../i18n';
import type { BoardBrushType, BoardTool } from './whiteboard_scene';

export interface BoardSettings {
  tool: BoardTool;
  brushType: BoardBrushType;
  color: string;
  width: number;
  opacity: number;
  filled: boolean;
  smoothing: number;
}
export function WhiteboardToolbar({ settings, onChange, canUndo, canRedo, onUndo, onRedo, onPasteImage }: {
  settings: BoardSettings; onChange(settings: BoardSettings): void; canUndo: boolean; canRedo: boolean;
  onUndo(): void; onRedo(): void; onPasteImage?(): void;
}) {
  const menu = useContextMenu();
  const [open, setOpen] = useState(true);
  const [shapeFilled, setShapeFilled] = useState<{ rectangle: boolean; ellipse: boolean }>({ rectangle: false, ellipse: false });
  const contentId = useId();
  const brushVariants = [
    ['pencil', Pencil, 'whiteboard.pencil'],
    ['pen', Pen, 'whiteboard.pen'],
    ['brush', Brush, 'whiteboard.brush'],
  ] as const;
  const activeBrush = brushVariants.find(([kind]) => kind === settings.brushType) ?? brushVariants[0];
  const ActiveBrushIcon = activeBrush[1];
  const activeBrushLabel = activeBrush[2];
  const tools = [
    ['pointer', MousePointer2],
    ['brush', ActiveBrushIcon],
    ['eraser', Eraser],
    ['rectangle', Square],
    ['ellipse', Circle],
    ['line', Minus],
  ] as const;
  const colors = [['#a47754', 'color.brown'], ['#ef4444', 'message.6741b8b5e1c2'], ['#f97316', 'message.2b2b4ad00333'],
    ['#facc15', 'message.1875203bcdcc'], ['#22c55e', 'message.40598e1cb1d2'], ['#06b6d4', 'message.c954e4de2019'],
    ['#3b82f6', 'message.b0bf526b23af'], ['#a855f7', 'message.57a73ede5f6f'], ['#ec4899', 'message.75f9577a1637'],
    ['#ffffff', 'message.3683a74222dd'], ['#000000', 'message.4b652af43d8d']];
  return <div className={`whiteboard-toolbar ${open ? '' : 'is-collapsed'}`} role="toolbar" aria-label={t('whiteboard.tools')}>
    <div className="whiteboard-toolbar-main-row">
      <div className="whiteboard-toolbar-history" inert={!open || undefined} aria-hidden={!open || undefined}>
        <TooltipButton tooltip={t('message.786b48222848')} className="room-app-notepad-tool" disabled={!canUndo} onClick={onUndo}><Undo2 size={17} /></TooltipButton>
        <TooltipButton tooltip={t('message.7b659c9caa5e')} className="room-app-notepad-tool" disabled={!canRedo} onClick={onRedo}><Redo2 size={17} /></TooltipButton>
      </div>
      <div className="whiteboard-tool-choices" inert={!open || undefined} aria-hidden={!open || undefined}>
        {tools.map(([tool, Icon]) => <TooltipButton key={tool} tooltip={t(tool === 'brush' ? activeBrushLabel : `whiteboard.${tool}`)} aria-pressed={settings.tool === tool}
          className={`room-app-notepad-tool ${settings.tool === tool ? 'active' : ''}`} onClick={event => {
            if (tool === 'brush') {
              const currentBrush = activeBrush[0];
              onChange({ ...settings, tool: 'brush', brushType: currentBrush });
              menu(event, brushVariants.map(([brushType, VariantIcon, labelKey]) => ({
                id: `brush-${brushType}`, label: t(labelKey), tooltip: t(labelKey), iconOnly: true,
                selected: currentBrush === brushType,
                icon: <VariantIcon size={18} strokeWidth={1.8} />,
                onSelect: () => onChange({ ...settings, tool: 'brush', brushType }),
              })), { toggle: true, layout: 'grid', placement: 'top-center' });
            } else if (tool === 'rectangle' || tool === 'ellipse') {
              const currentFilled = shapeFilled[tool];
              onChange({ ...settings, tool, filled: currentFilled });
              menu(event, [false, true].map(filled => ({
                id: `${tool}-${filled}`, label: t(filled ? 'whiteboard.filled' : 'whiteboard.outline'),
                tooltip: t(filled ? 'whiteboard.filled' : 'whiteboard.outline'), iconOnly: true,
                selected: currentFilled === filled,
                icon: <Icon size={18} fill={filled ? 'currentColor' : 'none'} strokeWidth={1.8} />,
                onSelect: () => {
                  setShapeFilled(prev => ({ ...prev, [tool]: filled }));
                  onChange({ ...settings, tool, filled });
                },
              })), { toggle: true, layout: 'grid', placement: 'top-center' });
            } else onChange({ ...settings, tool });
          }}><Icon size={19} fill={(tool === 'rectangle' || tool === 'ellipse') && (settings.tool === tool ? settings.filled : shapeFilled[tool]) ? 'currentColor' : 'none'} /></TooltipButton>)}
        {onPasteImage && <TooltipButton tooltip={t('whiteboard.pasteImage')} className="room-app-notepad-tool" onClick={onPasteImage}><ImagePlus size={19} /></TooltipButton>}
        <TooltipButton tooltip={t('message.2237b88f398f')} className="room-app-notepad-tool" onClick={event => menu(event, colors.map(([color, label]) => ({
          id: color, label: t(label), selected: color === settings.color, icon: <span className="stream-drawing-swatch" style={{ background: color }} />,
          onSelect: () => onChange({ ...settings, color }),
        })), { toggle: true })}><span className="stream-drawing-swatch" style={{ background: settings.color }} /></TooltipButton>
      </div>
      <TooltipButton tooltip={t(open ? 'whiteboard.hideTools' : 'whiteboard.showTools')} className="room-app-notepad-tool whiteboard-toolbar-toggle"
        aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(value => !value)}><ChevronDown size={20} strokeWidth={2.5} className={open ? '' : 'is-reversed'} /></TooltipButton>
    </div>
    <CollapsibleRegion open={open} id={contentId}>
      <div className="whiteboard-tool-properties">
        <IntegerSlider label={t('whiteboard.width')} min={1} max={100} value={settings.width} onChange={width => onChange({ ...settings, width })} />
        <IntegerSlider label={t('whiteboard.opacity')} min={1} max={100} value={settings.opacity} onChange={opacity => onChange({ ...settings, opacity })} />
        <IntegerSlider label={t('whiteboard.smoothing')} min={0} max={100} value={settings.smoothing} onChange={smoothing => onChange({ ...settings, smoothing })} />
      </div>
    </CollapsibleRegion>
  </div>;
}
