import { useLocale } from '../../hooks/useLocale';
import { localizeText, t } from '../../i18n';
import React from 'react';
import { Check, Info, TriangleAlert, CircleX, X } from 'lucide-react';
import { toastManager } from '../../hooks/useToast';
import { useToast } from '../../hooks/useToast';
import { TooltipButton } from './TooltipButton';
import { useToastStack } from '../../hooks/useToastStack';

export const ToastContainer: React.FC = () => {
  useLocale();
  const { toasts, removeToast } = useToast();

  const { items, refFor } = useToastStack(toasts);

  if (items.length === 0) return null;

  return (
    <div id="toast-container" className="toast-container">
      {items.map((toast) => (
        <div key={toast.id} className="toast-stack-item" ref={refFor(toast.id)}
          inert={toast.exiting} aria-hidden={toast.exiting || undefined}>
          <div className={`toast toast-${toast.type}${toast.exiting ? ' is-exiting' : ''}`} role={toast.exiting ? undefined : toast.type === 'error' ? 'alert' : 'status'}
            onMouseEnter={() => toastManager.pause(toast.id)}
            onMouseLeave={event => { if (!event.currentTarget.contains(document.activeElement)) toastManager.resume(toast.id); }}
            onFocus={() => toastManager.pause(toast.id)}
            onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) toastManager.resume(toast.id); }}>
            <span className="toast-icon" aria-hidden="true">{toast.type === 'success' ? <Check size={20} /> : toast.type === 'error' ? <CircleX size={20} /> : toast.type === 'warning' ? <TriangleAlert size={20} /> : <Info size={20} />}</span>
            <span className="toast-message">{localizeText(toast.message)}</span>
            <TooltipButton disabled={toast.exiting} className="btn-close toast-close" tooltip={t('message.0f2bd88ef0ac')}
              onClick={() => removeToast(toast.id)}><X size={16} aria-hidden="true" /></TooltipButton>
            <span className="toast-progress" aria-hidden="true" style={{ animationDuration: `${toast.durationMs}ms`, animationPlayState: toast.paused ? 'paused' : 'running' }} />
          </div>
        </div>
      ))}
    </div>
  );
};
