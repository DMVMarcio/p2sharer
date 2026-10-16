import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModalDialogBehavior } from './useModalDialogBehavior';
import { TooltipButton } from './TooltipButton';

interface Props {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  headerless?: boolean;
  headerActions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode | ((close: () => void) => ReactNode);
  className?: string;
  busy?: boolean;
  closeOnOutside?: boolean;
  onClose: () => void | Promise<void>;
  onCloseStart?: () => void;
}

export function ModalDialog({ title, subtitle, icon, headerless = false, headerActions, children, footer, className = '', busy = false, closeOnOutside = false, onClose, onCloseStart }: Props) {
  useLocale();
  const titleId = useId();
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  const closeStartRef = useRef(onCloseStart);
  const closingRef = useRef(false);
  const requestedCloseRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [closing, setClosing] = useState(false);
  closeRef.current = onClose;
  busyRef.current = busy;
  closeStartRef.current = onCloseStart;
  const close = () => {
    if (closingRef.current) return;
    if (busyRef.current) { requestedCloseRef.current = true; return; }
    closingRef.current = true;
    closeStartRef.current?.();
    setClosing(true);
    timerRef.current = setTimeout(() => {
      // A failed native close must leave controls usable for a retry.
      void Promise.resolve().then(() => closeRef.current()).catch(() => {
        closingRef.current = false; setClosing(false);
      });
    }, 240);
  };
  useEffect(() => {
    if (!busy && requestedCloseRef.current) {
      requestedCloseRef.current = false;
      close();
    }
  }, [busy]);
  const cardRef = useModalDialogBehavior(close, busy || closing, closeOnOutside);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return createPortal(<div className={`modal-overlay ${closing ? 'closing' : ''}`}
    onClick={(event) => event.stopPropagation()}
    >
    <div ref={cardRef} className={`modal-card ${className}`} role="dialog" aria-modal="true" aria-labelledby={headerless ? undefined : titleId} aria-label={headerless ? title : undefined} tabIndex={-1} inert={closing || undefined}>
      {headerless ? <div className="modal-overlay-actions">
        {headerActions}
        <TooltipButton className="btn-close modal-overlay-close" tooltip={t('message.0f2bd88ef0ac')} disabled={busy || closing} onClick={close}>&times;</TooltipButton>
      </div> : <div className="modal-header">
        {icon && <div className="modal-header-icon">{icon}</div>}
        <div><h2 id={titleId}>{title}</h2>{subtitle && <p className="modal-subtitle">{subtitle}</p>}</div>
        <TooltipButton className="btn-close" tooltip={t("message.0f2bd88ef0ac")} disabled={busy || closing} onClick={close}>&times;</TooltipButton>
      </div>}
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-footer">{typeof footer === 'function' ? footer(close) : footer}</div>}
    </div>
  </div>, document.fullscreenElement ?? document.body);
}
