import { Brush, Square, Circle, Type, MousePointer2, Eraser } from 'lucide-react';
import { TooltipButton } from '../common/TooltipButton';
import { useContextMenu } from '../common/ContextMenu';
import type { DrawingTool } from '../../core/stream_pointer';

export interface DrawingSettings { tool: DrawingTool | null; color: string; size: number; text: string }
const COLORS = [
  ['#ef4444', 'Vermelho'], ['#f97316', 'Laranja'], ['#facc15', 'Amarelo'], ['#22c55e', 'Verde'],
  ['#06b6d4', 'Ciano'], ['#3b82f6', 'Azul'], ['#a855f7', 'Roxo'], ['#ec4899', 'Rosa'],
  ['#ffffff', 'Branco'], ['#000000', 'Preto'],
];
export function StreamDrawingToolbar({ settings, onChange, onClear }: {
  settings: DrawingSettings; onChange: (settings: DrawingSettings) => void; onClear: () => void;
}) {
  const menu = useContextMenu();
  const tools = [[null, 'Mouse', MousePointer2], ['brush', 'Pincel', Brush], ['rectangle', 'Quadrado', Square],
    ['ellipse', 'Círculo', Circle], ['text', 'Texto', Type]] as const;
  return <div className="stream-drawing-toolbar" role="toolbar" aria-label="Rabiscos"
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}>
    {tools.map(([tool, label, Icon]) => <TooltipButton key={label} tooltip={label} className={`btn-stream-pin ${settings.tool === tool ? 'active' : ''}`}
      aria-pressed={settings.tool === tool} onClick={() => onChange({ ...settings, tool })}><Icon size={15} /></TooltipButton>)}
    <TooltipButton tooltip="Cor" className="btn-stream-pin" onClick={event => menu(event, COLORS.map(([color, label]) => ({
      id: color, label, icon: <span className="stream-drawing-swatch" style={{ background: color }} />,
      onSelect: () => onChange({ ...settings, color }),
    })))}><span className="stream-drawing-swatch" style={{ background: settings.color }} /></TooltipButton>
    <label className="stream-drawing-size">Tamanho <input autoComplete="off" className="stream-volume-range" type="range" min={0} max={10} step={1}
      value={settings.size} onChange={event => onChange({ ...settings, size: Number(event.target.value) })} /><output>{settings.size}</output></label>
    {settings.tool === 'text' && <input autoComplete="off" className="text-input text-input-sm" aria-label="Texto do rabisco"
      placeholder="Texto para inserir na tela" maxLength={160} value={settings.text} onChange={event => onChange({ ...settings, text: event.target.value })} />}
    <TooltipButton tooltip="Apagar meus rabiscos" className="btn-stream-pin" onClick={onClear}><Eraser size={15} /></TooltipButton>
  </div>;
}
