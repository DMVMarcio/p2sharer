import { Brush, MousePointer2, Square, Circle, Minus, Undo2, Redo2 } from 'lucide-react';
import { TooltipButton } from '../components/common/TooltipButton';
import { useContextMenu } from '../components/common/ContextMenu';
import { t } from '../i18n';
import type { BoardTool } from './whiteboard_scene';

export interface BoardSettings { tool: BoardTool; color: string; width: number; filled: boolean; smoothing: number }
export function WhiteboardToolbar({ settings, onChange, canUndo, canRedo, onUndo, onRedo }: {
  settings: BoardSettings; onChange(settings: BoardSettings): void; canUndo: boolean; canRedo: boolean;
  onUndo(): void; onRedo(): void;
}) {
  const menu = useContextMenu();
  const tools = [['pointer', MousePointer2], ['brush', Brush], ['rectangle', Square], ['ellipse', Circle], ['line', Minus]] as const;
  const colors = [['#a47754', 'color.brown'], ['#ef4444', 'message.6741b8b5e1c2'], ['#f97316', 'message.2b2b4ad00333'],
    ['#facc15', 'message.1875203bcdcc'], ['#22c55e', 'message.40598e1cb1d2'], ['#06b6d4', 'message.c954e4de2019'],
    ['#3b82f6', 'message.b0bf526b23af'], ['#a855f7', 'message.57a73ede5f6f'], ['#ec4899', 'message.75f9577a1637'],
    ['#ffffff', 'message.3683a74222dd'], ['#000000', 'message.4b652af43d8d']];
  return <div className="whiteboard-toolbar" role="toolbar" aria-label={t('whiteboard.tools')}>
    <div className="whiteboard-tool-choices">
    {tools.map(([tool, Icon]) => <TooltipButton key={tool} tooltip={t(`whiteboard.${tool}`)} aria-pressed={settings.tool === tool}
      className={`room-app-notepad-tool ${settings.tool === tool ? 'active' : ''}`} onClick={event => {
        if (tool === 'rectangle' || tool === 'ellipse') menu(event, [false, true].map(filled => ({
          id: `${tool}-${filled}`, label: t(filled ? 'whiteboard.filled' : 'whiteboard.outline'), iconOnly: true,
          selected: settings.tool === tool && settings.filled === filled,
          icon: <Icon size={30} fill={filled ? 'currentColor' : 'none'} strokeWidth={1.8} />,
          onSelect: () => onChange({ ...settings, tool, filled }),
        })), { toggle: true, layout: 'grid' });
        else onChange({ ...settings, tool });
      }}><Icon size={19} fill={settings.tool === tool && settings.filled && (tool === 'rectangle' || tool === 'ellipse') ? 'currentColor' : 'none'} /></TooltipButton>)}
    <TooltipButton tooltip={t('message.2237b88f398f')} className="room-app-notepad-tool" onClick={event => menu(event, colors.map(([color, label]) => ({
      id: color, label: t(label), selected: color === settings.color, icon: <span className="stream-drawing-swatch" style={{ background: color }} />,
      onSelect: () => onChange({ ...settings, color }),
    })), { toggle: true })}><span className="stream-drawing-swatch" style={{ background: settings.color }} /></TooltipButton>
    </div>
    <div className="whiteboard-tool-properties">
    <label className="stream-drawing-size">{t('whiteboard.width')}<input autoComplete="off" className="stream-volume-range" aria-label={t('whiteboard.width')}
      type="range" min={1} max={100} value={settings.width} onChange={event => onChange({ ...settings, width: Number(event.target.value) })} /><output>{settings.width}</output></label>
    <label className="stream-drawing-size">{t('whiteboard.smoothing')}<input autoComplete="off" className="stream-volume-range" aria-label={t('whiteboard.smoothing')}
      type="range" min={0} max={100} value={settings.smoothing} onChange={event => onChange({ ...settings, smoothing: Number(event.target.value) })} /><output>{settings.smoothing}</output></label>
    <TooltipButton tooltip={t('message.786b48222848')} className="room-app-notepad-tool" disabled={!canUndo} onClick={onUndo}><Undo2 size={16} /></TooltipButton>
    <TooltipButton tooltip={t('message.7b659c9caa5e')} className="room-app-notepad-tool" disabled={!canRedo} onClick={onRedo}><Redo2 size={16} /></TooltipButton>
    </div>
  </div>;
}
