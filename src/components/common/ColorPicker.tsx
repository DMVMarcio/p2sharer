import { useId, useState } from 'react';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { ModalDialog } from './ModalDialog';
import { TooltipButton } from './TooltipButton';

function ColorPickerDialog({ value, label, onApply, onClose }: {
  value: string; label: string; onApply: (color: string) => void; onClose: () => void;
}) {
  useLocale();
  const id = useId();
  const [color, setColor] = useState(value);
  const [hex, setHex] = useState(value);
  const valid = /^#[0-9a-f]{6}$/i.test(hex);
  const channels = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
  const labels = [t('color.red'), t('color.green'), t('color.blue')];
  const changeChannel = (index: number, channel: number) => {
    const next = channels.map((value, position) => position === index ? channel : value);
    const nextColor = `#${next.map(value => value.toString(16).padStart(2, '0')).join('')}`;
    setColor(nextColor);
    setHex(nextColor);
  };
  return <ModalDialog title={label} className="color-picker-dialog" onClose={onClose}
    footer={close => <>
      <button type="button" className="btn btn-secondary" onClick={close}>{t('message.bb9dbb406dcb')}</button>
      <button type="button" className="btn btn-primary" disabled={!valid}
        onClick={() => { onApply(hex.toLowerCase()); close(); }}>{t('message.3a04898a6b8b')}</button>
    </>}>
    <div className="color-picker-preview" style={{ backgroundColor: color }} aria-label={t('color.preview')} />
    <div className="color-picker-channels">
      {channels.map((channel, index) => {
        const start = channels.map((value, position) => position === index ? 0 : value);
        const end = channels.map((value, position) => position === index ? 255 : value);
        return <label className="color-picker-channel" key={index}>
          <span>{labels[index]}</span>
          <input autoComplete="off" type="range" min={0} max={255} step={1} value={channel}
            aria-label={labels[index]} className="settings-slider-input"
            style={{ background: `linear-gradient(to right, rgb(${start.join(',')}), rgb(${end.join(',')}))` }}
            onChange={event => changeChannel(index, Number(event.target.value))} />
          <output>{channel}</output>
        </label>;
      })}
    </div>
    <label className="form-label" htmlFor={id}>{t('color.hex')}</label>
    <input autoComplete="off" id={id} data-autofocus className="text-input" value={hex} maxLength={7}
      aria-invalid={!valid} spellCheck={false} onChange={event => {
        const next = event.target.value;
        setHex(next);
        if (/^#[0-9a-f]{6}$/i.test(next)) setColor(next);
      }} />
  </ModalDialog>;
}

export function ColorPicker({ value, label, onChange, active = false }: {
  value: string; label: string; onChange: (color: string) => void; active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <TooltipButton tooltip={label} aria-haspopup="dialog" aria-expanded={open}
      className={`accent-swatch custom-color-picker ${active ? 'active' : ''}`}
      onClick={() => setOpen(true)}>
      <span className="custom-color-picker-swatch" style={{ backgroundColor: value }} />
    </TooltipButton>
    {open && <ColorPickerDialog value={value} label={label} onApply={onChange} onClose={() => setOpen(false)} />}
  </>;
}
