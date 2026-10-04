import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { Upload } from 'lucide-react';

export function ChatFileDropOverlay() {
  useLocale();
  return <div className="chat-file-drop-overlay" role="status" aria-live="polite">
    <Upload size={32} aria-hidden="true" />
    <strong>{t("message.2a1c8c50c14c")}</strong>
    <span>{t("message.ab0ae2d8be66")}</span>
  </div>;
}
