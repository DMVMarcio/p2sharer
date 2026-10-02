import { Brush, Square, Circle, Type, MousePointer2, Eraser, Undo2, Redo2 } from 'lucide-react';
import { TooltipButton } from '../common/TooltipButton';
import { useContextMenu } from '../common/ContextMenu';
import type { DrawingTool } from '../../core/stream_pointer';

export interface DrawingSettings { tool: DrawingTool | null; color: string; size: number }
const COLORS = [
  ['#ef4444', 'Vermelho'], ['#f97316', 'Laranja'], ['#facc15', 'Amarelo'], ['#22c55e', 'Verde'],
  ['#06b6d4', 'Ciano'], ['#3b82f6', 'Azul'], ['#a855f7', 'Roxo'], ['#ec4899', 'Rosa'],
  ['#ffffff', 'Branco'], ['#000000', 'Preto'],
];
export function StreamDrawingToolbar({ settings, onChange, onClear, onUndo, onRedo, canUndo, canRedo }: {
  settings: DrawingSettings; onChange: (settings: DrawingSettings) => void; onClear: () => void; onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean;
}) {
  const menu = useContextMenu();
  const tools = [[null, 'Mouse', MousePointer2], ['brush', 'Pincel', Brush], ['rectangle', 'Quadrado', Square],
    ['ellipse', 'Círculo', Circle], ['text', 'Texto', Type]] as const;
  return <div className="stream-drawing-toolbar" role="toolbar" aria-label="Rabiscos"
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}>
    {tools.map(([tool, label, Icon]) => <TooltipButton key={label} tooltip={label} className={`btn-stream-pin ${settings.tool === tool ? 'active' : ''}`}
      aria-pressed={settings.tool === tool} onClick={() => onChange({ ...settings, tool: settings.tool === tool ? null : tool })}><Icon size={15} /></TooltipButton>)}
    <TooltipButton tooltip="Cor" className="btn-stream-pin" onClick={event => menu(event, COLORS.map(([color, label]) => ({
      id: color, label, selected: color === settings.color, icon: <span className="stream-drawing-swatch" style={{ background: color }} />,
      onSelect: () => onChange({ ...settings, color }),
    })), { toggle: true })}><span className="stream-drawing-swatch" style={{ background: settings.color }} /></TooltipButton>
    <label className="stream-drawing-size">Tamanho <input autoComplete="off" className="stream-volume-range" type="range" min={0} max={10} step={1}
      value={settings.size} onChange={event => onChange({ ...settings, size: Number(event.target.value) })} /><output>{settings.size}</output></label>
    <div className="stream-drawing-history">
      <TooltipButton tooltip="Desfazer (Ctrl+Z)" aria-label="Desfazer" className="btn-stream-pin" disabled={!canUndo} onClick={onUndo}><Undo2 size={15} /></TooltipButton>
      <TooltipButton tooltip="Refazer (Ctrl+Y)" aria-label="Refazer" className="btn-stream-pin" disabled={!canRedo} onClick={onRedo}><Redo2 size={15} /></TooltipButton>
      <TooltipButton tooltip="Apagar meus rabiscos" className="btn-stream-pin" onClick={onClear}><Eraser size={15} /></TooltipButton>
    </div>
  </div>;
}
