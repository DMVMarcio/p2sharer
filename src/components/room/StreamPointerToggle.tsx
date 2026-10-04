import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { MousePointer2 } from 'lucide-react';
import { Tooltip } from '../common/Tooltip';

export function StreamPointerToggle({ enabled, onToggle, onTooltipOpenChange }: {
  enabled: boolean; onToggle: () => void; onTooltipOpenChange?: (open: boolean) => void;
}) {
  useLocale();
  const label = enabled ? t("message.1e6d9ea1d09f") : t("message.78171c7652c2");
  return <Tooltip content={label} onOpenChange={onTooltipOpenChange}>
    <button type="button" className={`btn-stream-pin ${enabled ? 'active' : ''}`} aria-label={label}
      aria-pressed={enabled} onClick={(event) => { event.stopPropagation(); onToggle(); }}>
      <MousePointer2 size={15} />
    </button>
  </Tooltip>;
}
