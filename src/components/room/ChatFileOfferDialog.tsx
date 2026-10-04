import { localizeText, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useState } from 'react';
import type { NativeChatFile } from '../../p2p/group_room';
import { formatFileSize } from '../../core/file_size';
import { Paperclip } from 'lucide-react';

interface Props { file: NativeChatFile; onClose: () => void; onOffer: (name: string, autoAccept: boolean) => Promise<void> }

export function ChatFileOfferDialog({ file, onClose, onOffer }: Props) {
  useLocale();
  const [name, setName] = useState(file.name);
  const [autoAccept, setAutoAccept] = useState(() => file.isImage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true);
    try { await onOffer(name.trim(), autoAccept); onClose(); }
    catch { setError(t("message.fb1fa51a323d")); }
    finally { setBusy(false); }
  };
  return <div className="modal-overlay" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <div className="modal-card chat-file-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-file-dialog-title">
      <div className="modal-header"><div className="modal-header-icon"><Paperclip size={19} /></div><div><h2 id="chat-file-dialog-title">{t("message.0176661d7e81")}</h2>
        <p className="modal-subtitle">{t("message.a9477d069b1b")}</p></div>
        <button className="btn-close" aria-label={t("message.0f2bd88ef0ac")} disabled={busy} onClick={onClose}>&times;</button></div>
      <div className="modal-body chat-file-dialog-body">
        <div className="form-group"><label className="form-label" htmlFor="chat-file-name">{t("message.c586d2b42a35")}</label>
          <input autoComplete="off" className="text-input" id="chat-file-name" value={name} maxLength={180}
            onChange={(event) => setName(event.target.value)} /></div>
        <div className="chat-file-detail"><span>{formatFileSize(file.size)}</span><span>SHA-256 {file.hash}</span></div>
        <div className="chat-file-switch"><span>{t("message.c9d0a3d3c5ee")}</span>
          <label className="modern-switch"><input autoComplete="off" type="checkbox" checked={autoAccept}
            aria-label={t("message.c9d0a3d3c5ee")}
            onChange={(event) => setAutoAccept(event.target.checked)} /><span className="switch-slider" /></label></div>
        <p className="chat-file-observation"><strong>{t("message.630f02eff4ae")}</strong>  {t("message.2aaef5696c80")}</p>
        {error && <p className="chat-file-error">{localizeText(error)}</p>}
      </div>
      <div className="modal-footer"><button className="btn btn-secondary" disabled={busy} onClick={onClose}>{t("message.bb9dbb406dcb")}</button>
        <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void submit()}>{t("message.3ee59a68ed11")}</button></div>
    </div>
  </div>;
}
