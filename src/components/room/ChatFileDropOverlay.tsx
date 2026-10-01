import { Upload } from 'lucide-react';

export function ChatFileDropOverlay() {
  return <div className="chat-file-drop-overlay" role="status" aria-live="polite">
    <Upload size={32} aria-hidden="true" />
    <strong>Solte o arquivo aqui</strong>
    <span>Confirme o envio na próxima etapa.</span>
  </div>;
}
