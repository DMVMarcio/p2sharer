import { useId, useState } from 'react';
import { Pencil } from 'lucide-react';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { ModalDialog } from './ModalDialog';
import { TooltipButton } from './TooltipButton';
import { hexToHsv, hsvToHex, type Hsv } from '../../core/hsv_color';
import { contrastingTextColor } from '../../core/accent_color';

function ColorPickerDialog({ value, label, onApply, onClose }: {
  value: string; label: string; onApply: (color: string) => void; onClose: () => void;
}) {
  useLocale();
  const id = useId();
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const color = hsvToHex(hsv);
  const [hex, setHex] = useState(value);
  const valid = /^#[0-9a-f]{6}$/i.test(hex);
  const change = (next: Hsv) => { setHsv(next); setHex(hsvToHex(next)); };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    change({ ...hsv, s: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      v: 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) });
  };
  return <ModalDialog title={label} className="color-picker-dialog" onClose={onClose}
    footer={close => <>
      <button type="button" className="btn btn-secondary" onClick={close}>{t('message.bb9dbb406dcb')}</button>
      <button type="button" className="btn btn-primary" disabled={!valid}
        onClick={() => { onApply(hex.toLowerCase()); close(); }}>{t('message.3a04898a6b8b')}</button>
    </>}>
    <div className="color-picker-preview" style={{ backgroundColor: color }} aria-label={t('color.preview')} />
    <div className="color-picker-sv" style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
      role="group" aria-label={t('color.saturationValue')}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); move(event); }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event); }}>
      <span className="color-picker-sv-cursor" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
    </div>
    <div className="color-picker-channels">
      {(['h', 's', 'v'] as const).map(channel => {
        const label = t(channel === 'h' ? 'color.hue' : channel === 's' ? 'color.saturation' : 'color.value');
        const max = channel === 'h' ? 359 : 100;
        const value = Math.round(hsv[channel] * (channel === 'h' ? 1 : 100));
        return <label className="color-picker-channel" key={channel}>
          <span>{label}</span>
          <input autoComplete="off" type="range" min={0} max={max} step={1} value={value}
            aria-label={label} className={`settings-slider-input ${channel === 'h' ? 'color-picker-hue' : ''}`}
            onChange={event => change({ ...hsv, [channel]: Number(event.target.value) / (channel === 'h' ? 1 : 100) })} />
          <output>{value}{channel === 'h' ? '°' : '%'}</output>
        </label>;
      })}
    </div>
    <label className="form-label" htmlFor={id}>{t('color.hex')}</label>
    <input autoComplete="off" id={id} data-autofocus className="text-input" value={hex} maxLength={7}
      aria-invalid={!valid} spellCheck={false} onChange={event => {
        const next = event.target.value;
        setHex(next);
        if (/^#[0-9a-f]{6}$/i.test(next)) setHsv(hexToHsv(next));
      }} />
  </ModalDialog>;
}

export function ColorPicker({ value, label, onChange, active = false, disabled = false, variant = 'swatch' }: {
  value: string; label: string; onChange: (color: string) => void; active?: boolean; disabled?: boolean;
  variant?: 'swatch' | 'tile';
}) {
  const [open, setOpen] = useState(false);
  return <>
    <TooltipButton tooltip={label} disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
      className={`accent-swatch custom-color-picker ${variant === 'tile' ? 'custom-color-picker-tile' : ''} ${active ? 'active' : ''}`}
      onClick={() => setOpen(true)}>
      <span className="custom-color-picker-swatch" style={{ backgroundColor: value }} />
      {variant === 'tile' && <Pencil className="custom-color-picker-edit" size={16} aria-hidden="true"
        style={{ color: contrastingTextColor(value) }} />}
    </TooltipButton>
    {open && <ColorPickerDialog value={value} label={label} onApply={onChange} onClose={() => setOpen(false)} />}
  </>;
}
