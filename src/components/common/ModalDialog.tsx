import { useOverlayMotion } from '../../hooks/useOverlayMotion';
import { useDialogDismiss } from '../../hooks/useDialogDismiss';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useId, useRef, type ReactNode } from 'react';
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
  closing?: boolean;
  closeOnOutside?: boolean;
  onClose: () => void;
  onCloseStart?: () => void;
}

export function ModalDialog({ title, subtitle, icon, headerless = false, headerActions, children, footer, className = '', busy = false, closing: externalClosing = false, closeOnOutside = false, onClose, onCloseStart }: Props) {
  useLocale();
  const titleId = useId();
  const { closing: localClosing, close } = useDialogDismiss(onClose, busy, onCloseStart);
  const closing = externalClosing || localClosing;
  const overlayRef = useRef<HTMLDivElement>(null);
  useOverlayMotion(overlayRef, !closing, 'dialog');
  const cardRef = useModalDialogBehavior(close, busy || closing, closeOnOutside);
  return createPortal(<div ref={overlayRef} inert={closing || undefined} className={`modal-overlay ${closing ? 'closing' : ''}`}
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
  </div>, document.body);
}
