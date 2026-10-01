import { MousePointer2 } from 'lucide-react';
import { Tooltip } from '../common/Tooltip';

export function StreamPointerToggle({ enabled, onToggle, onTooltipOpenChange }: {
  enabled: boolean; onToggle: () => void; onTooltipOpenChange?: (open: boolean) => void;
}) {
  const label = enabled ? 'Desativar apontamento' : 'Apontar na transmissão';
  return <Tooltip content={label} onOpenChange={onTooltipOpenChange}>
    <button type="button" className={`btn-stream-pin ${enabled ? 'active' : ''}`} aria-label={label}
      aria-pressed={enabled} onClick={(event) => { event.stopPropagation(); onToggle(); }}>
      <MousePointer2 size={15} />
    </button>
  </Tooltip>;
}
