import { useLocale } from '../../hooks/useLocale';
import { localizeText } from '../../i18n';
import React from 'react';
import { Check, Info, TriangleAlert, CircleX } from 'lucide-react';
import { toastManager } from '../../hooks/useToast';
import { useToast } from '../../hooks/useToast';

export const ToastContainer: React.FC = () => {
  useLocale();
  const { toasts } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div id="toast-container" className="toast-container">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}
          onMouseEnter={() => toastManager.pause(toast.id)} onMouseLeave={() => toastManager.resume(toast.id)}>
          <span className="toast-icon" aria-hidden="true">{toast.type === 'success' ? <Check size={20} /> : toast.type === 'error' ? <CircleX size={20} /> : toast.type === 'warning' ? <TriangleAlert size={20} /> : <Info size={20} />}</span>
          <span className="toast-message">{localizeText(toast.message)}</span>
          <span className="toast-progress" aria-hidden="true" style={{ animationDuration: `${toast.durationMs}ms`, animationPlayState: toast.paused ? 'paused' : 'running' }} />
        </div>
      ))}
    </div>
  );
};
