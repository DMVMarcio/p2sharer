import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import { DownloadPanel } from './DownloadPanel';
import { useDropdownPresence } from '../../hooks/useDropdownPresence';
import { useLocale } from '../../hooks/useLocale';
import { t } from '../../i18n';

export function DownloadButton() {
  useLocale();
  const [open, setOpen] = useState(false);
  const presence = useDropdownPresence(open ? true : null);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const [height, setHeight] = useState(480);
  useEffect(() => {
    if (!open) return;
    const position = () => setHeight(Math.max(120, window.innerHeight - (trigger.current?.getBoundingClientRect().bottom ?? 0) - 18));
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    };
    position();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
    };
  }, [open]);
  useEffect(() => { if (open) panel.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [open]);
  return <div className="download-dropdown" ref={container} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }}>
    <button ref={trigger} className="btn btn-secondary" onClick={() => setOpen(value => !value)}
      aria-expanded={open} aria-controls={presence.value ? id : undefined} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); panel.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
      }}>
      <Download size={18} aria-hidden="true" />{t('downloads.title')}<ChevronDown size={15} aria-hidden="true" />
    </button>
    {presence.value && <div ref={panel} id={id} className={`download-dropdown-panel${presence.closing ? ' dropdown-closing' : ''}`}
      inert={presence.closing} style={{ maxHeight: height }}><DownloadPanel compact /></div>}
  </div>;
}
