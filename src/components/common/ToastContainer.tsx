import { useLocale } from '../../hooks/useLocale';
import { localizeText } from '../../i18n';
import React from 'react';
import { useToast } from '../../hooks/useToast';

export const ToastContainer: React.FC = () => {
  useLocale();
  const { toasts } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div id="toast-container" className="toast-container">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          {localizeText(toast.message)}
        </div>
      ))}
    </div>
  );
};
