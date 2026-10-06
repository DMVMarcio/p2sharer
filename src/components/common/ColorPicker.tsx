import { Tooltip } from './Tooltip';

export function ColorPicker({ value, label, onChange, active = false }: {
  value: string; label: string; onChange: (color: string) => void; active?: boolean;
}) {
  return <Tooltip content={label}>
    <input type="color" autoComplete="off" aria-label={label}
      className={`accent-swatch custom-color-picker ${active ? 'active' : ''}`}
      value={value} onChange={event => onChange(event.target.value)} />
  </Tooltip>;
}
