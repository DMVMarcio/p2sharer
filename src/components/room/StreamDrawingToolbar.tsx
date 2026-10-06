import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { Brush, Square, Circle, Type, MousePointer2, Eraser, Undo2, Redo2 } from 'lucide-react';
import { TooltipButton } from '../common/TooltipButton';
import { useContextMenu } from '../common/ContextMenu';
import type { DrawingTool } from '../../core/stream_pointer';

export interface DrawingSettings { tool: DrawingTool | null; color: string; size: number }
const getColors = () => [
  ['#a47754', t('color.brown')],
  ['#ef4444', t("message.6741b8b5e1c2")], ['#f97316', t("message.2b2b4ad00333")], ['#facc15', t("message.1875203bcdcc")], ['#22c55e', t("message.40598e1cb1d2")],
  ['#06b6d4', t("message.c954e4de2019")], ['#3b82f6', t("message.b0bf526b23af")], ['#a855f7', t("message.57a73ede5f6f")], ['#ec4899', t("message.75f9577a1637")],
  ['#ffffff', t("message.3683a74222dd")], ['#000000', t("message.4b652af43d8d")],
];
export function StreamDrawingToolbar({ settings, onChange, onClear, onUndo, onRedo, canUndo, canRedo }: {
  settings: DrawingSettings; onChange: (settings: DrawingSettings) => void; onClear: () => void; onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean;
}) {
  useLocale();
  const menu = useContextMenu();
  const tools = [[null, 'Mouse', MousePointer2], ['brush', t("message.85994c733ba0"), Brush], ['rectangle', t("message.cb0a64bafea0"), Square],
    ['ellipse', t("message.b6802094bd53"), Circle], ['text', t("message.6df3d6661c09"), Type]] as const;
  return <div className="stream-drawing-toolbar" role="toolbar" aria-label={t("message.cc98e54ce18c")}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}>
    {tools.map(([tool, label, Icon]) => <TooltipButton key={label} tooltip={label} className={`btn-stream-pin ${settings.tool === tool ? 'active' : ''}`}
      aria-pressed={settings.tool === tool} onClick={() => onChange({ ...settings, tool: settings.tool === tool ? null : tool })}><Icon size={15} /></TooltipButton>)}
    <TooltipButton tooltip={t("message.2237b88f398f")} className="btn-stream-pin" onClick={event => menu(event, getColors().map(([color, label]) => ({
      id: color, label, selected: color === settings.color, icon: <span className="stream-drawing-swatch" style={{ background: color }} />,
      onSelect: () => onChange({ ...settings, color }),
    })), { toggle: true })}><span className="stream-drawing-swatch" style={{ background: settings.color }} /></TooltipButton>
    <label className="stream-drawing-size">{t("message.21bed0eaf1e5")} <input autoComplete="off" className="stream-volume-range" type="range" min={0} max={10} step={1}
      value={settings.size} onChange={event => onChange({ ...settings, size: Number(event.target.value) })} /><output>{settings.size}</output></label>
    <div className="stream-drawing-history">
      <TooltipButton tooltip={t("message.e8908ee8f72b")} aria-label={t("message.786b48222848")} className="btn-stream-pin" disabled={!canUndo} onClick={onUndo}><Undo2 size={15} /></TooltipButton>
      <TooltipButton tooltip={t("message.189406ffe91a")} aria-label={t("message.7b659c9caa5e")} className="btn-stream-pin" disabled={!canRedo} onClick={onRedo}><Redo2 size={15} /></TooltipButton>
      <TooltipButton tooltip={t("message.0d51d0b09fad")} className="btn-stream-pin" onClick={onClear}><Eraser size={15} /></TooltipButton>
    </div>
  </div>;
}
