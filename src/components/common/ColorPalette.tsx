import type { CSSProperties } from 'react';
import { t } from '../../i18n';
import { TooltipButton } from './TooltipButton';
import { ColorPicker } from './ColorPicker';

export interface ColorPreset { value: string; label: string; color: string }

export function ColorPalette({ value, onChange, presets, label, disabled = false, id }: {
  value: string; onChange: (value: string) => void; presets: readonly ColorPreset[];
  label: string; disabled?: boolean; id?: string;
}) {
  const selected = presets.find(preset => preset.value === value);
  return <div className="accent-colors-palette" id={id} role="group" aria-label={label}>
    {presets.map(preset => <TooltipButton key={preset.value} tooltip={preset.label} disabled={disabled}
      className={`accent-swatch ${selected === preset ? 'active' : ''}`} aria-pressed={selected === preset}
      style={{ '--swatch-color': preset.color } as CSSProperties} onClick={() => onChange(preset.value)} />)}
    <ColorPicker label={t('color.custom')} active={!selected} disabled={disabled}
      value={selected?.color ?? value} onChange={onChange} />
  </div>;
}
