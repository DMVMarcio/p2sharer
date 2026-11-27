import { useEffect, useRef, useState } from 'react';

/** A range and directly editable integer share one corrected, bounded value. */
export function IntegerSlider({ label, value, min, max, onChange }: {
  label: string; value: number; min: number; max: number; onChange(value: number): void;
}) {
  const [draft, setDraft] = useState(String(value));
  const cancelling = useRef(false);
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const corrected = Math.max(min, Math.min(max, Number(draft || min)));
    setDraft(String(corrected)); onChange(corrected);
  };
  return <label className="stream-drawing-size integer-slider">{label}
    <input autoComplete="off" className="stream-volume-range" aria-label={label} type="range" min={min} max={max} step={1}
      value={value} onChange={event => onChange(Number(event.target.value))} />
    <input autoComplete="off" className="text-input-sm integer-slider-value" aria-label={label} inputMode="numeric" pattern="[0-9]*"
      value={draft} onFocus={event => event.currentTarget.select()} onBlur={() => { if (!cancelling.current) commit(); cancelling.current = false; }}
      onBeforeInput={event => { const data = (event.nativeEvent as InputEvent).data; if (data && /\D/.test(data)) event.preventDefault(); }}
      onChange={event => { if (/^\d{0,6}$/.test(event.target.value)) setDraft(event.target.value); }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur(); }
        else if (event.key === 'Escape') { cancelling.current = true; setDraft(String(value)); event.currentTarget.blur(); }
        else if (!event.ctrlKey && !event.metaKey && event.key.length === 1 && /\D/.test(event.key)) event.preventDefault();
      }} />
  </label>;
}
