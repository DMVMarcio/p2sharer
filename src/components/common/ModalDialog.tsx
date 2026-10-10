import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode | ((close: () => void) => ReactNode);
  className?: string;
  busy?: boolean;
  onClose: () => void;
  onCloseStart?: () => void;
}

export function ModalDialog({ title, subtitle, icon, children, footer, className = '', busy = false, onClose, onCloseStart }: Props) {
  useLocale();
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  const closeStartRef = useRef(onCloseStart);
  const closingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [closing, setClosing] = useState(false);
  closeRef.current = onClose;
  busyRef.current = busy;
  closeStartRef.current = onCloseStart;
  const close = () => {
    if (busyRef.current || closingRef.current) return;
    closingRef.current = true;
    closeStartRef.current?.();
    setClosing(true);
    timerRef.current = setTimeout(() => closeRef.current(), 240);
  };
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    const focusables = () => Array.from(card?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
    (card?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? card)?.focus();
    const keydown = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== card) return;
      if (event.key === 'Escape' && event.target instanceof Element && event.target.closest('[role="combobox"][aria-expanded="true"]')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      if (event.key === 'Tab') {
        const controls = focusables();
        const target = document.activeElement;
        if (!controls.length) { event.preventDefault(); card?.focus(); }
        else if (event.shiftKey && (target === controls[0] || !card?.contains(target))) {
          event.preventDefault(); controls[controls.length - 1].focus();
        } else if (!event.shiftKey && (target === controls[controls.length - 1] || !card?.contains(target))) {
          event.preventDefault(); controls[0].focus();
        }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      clearTimeout(timerRef.current);
      document.removeEventListener('keydown', keydown, true);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return createPortal(<div className={`modal-overlay ${closing ? 'closing' : ''}`}
    onClick={(event) => event.stopPropagation()}
    onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div ref={cardRef} className={`modal-card ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} inert={closing || undefined}>
      <div className="modal-header">
        {icon && <div className="modal-header-icon">{icon}</div>}
        <div><h2 id={titleId}>{title}</h2>{subtitle && <p className="modal-subtitle">{subtitle}</p>}</div>
        <button type="button" className="btn-close" aria-label={t("message.0f2bd88ef0ac")} disabled={busy || closing} onClick={close}>&times;</button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-footer">{typeof footer === 'function' ? footer(close) : footer}</div>}
    </div>
  </div>, document.body);
}
