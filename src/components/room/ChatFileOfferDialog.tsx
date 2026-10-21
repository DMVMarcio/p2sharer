import { ModalDialog } from '../common/ModalDialog';
import { localizeText, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useEffect, useState } from 'react';
import type { NativeChatFile } from '../../p2p/group_room';
import { formatFileSize } from '../../core/file_size';
import { Paperclip } from 'lucide-react';

export type ChatOfferFile = NativeChatFile & { loading?: boolean };

interface Props {
  file: ChatOfferFile;
  onClose: () => void;
  onOffer: (name: string, autoAccept: boolean) => Promise<void>;
}

export function ChatFileOfferDialog({ file, onClose, onOffer }: Props) {
  useLocale();
  const [name, setName] = useState(file.name);
  const [autoAccept, setAutoAccept] = useState(() => Boolean(file.isImage));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setName(file.name);
  }, [file.name]);

  useEffect(() => {
    if (file.isImage) setAutoAccept(true);
  }, [file.isImage]);

  const submit = async (close: () => void) => {
    if (file.loading || !file.hash) return;
    setBusy(true);
    try {
      await onOffer(name.trim(), autoAccept);
      close();
    } catch {
      setError(t("message.fb1fa51a323d"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      title={t("message.0176661d7e81")}
      subtitle={file.loading ? t("chat.filePreparing") : t("message.a9477d069b1b")}
      icon={<Paperclip size={19} />}
      className="chat-file-dialog"
      busy={busy}
      onClose={onClose}
      footer={close => (
        <>
          <button className="btn btn-secondary" disabled={busy} onClick={close}>
            {t("message.bb9dbb406dcb")}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || file.loading || !name.trim() || !file.hash}
            onClick={() => void submit(close)}
          >
            {t("message.3ee59a68ed11")}
          </button>
        </>
      )}
    >
      <div className="chat-file-dialog-body">
        <div className="form-group">
          <label className="form-label" htmlFor="chat-file-name">{t("message.c586d2b42a35")}</label>
          <input
            autoComplete="off"
            className="text-input"
            id="chat-file-name"
            value={name}
            maxLength={180}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="chat-file-detail">
          <span>{file.size > 0 ? formatFileSize(file.size) : (file.loading ? '...' : formatFileSize(0))}</span>
          <span>
            {file.loading ? (
              <span className="chat-file-loading-state">
                <span className="chat-file-spinner" />
                <span>{t("chat.fileIndexing")}</span>
              </span>
            ) : (
              `SHA-256 ${file.hash}`
            )}
          </span>
        </div>
        <div className="chat-file-switch">
          <span>{t("message.c9d0a3d3c5ee")}</span>
          <label className="modern-switch">
            <input
              autoComplete="off"
              type="checkbox"
              checked={autoAccept}
              aria-label={t("message.c9d0a3d3c5ee")}
              onChange={(event) => setAutoAccept(event.target.checked)}
            />
            <span className="switch-slider" />
          </label>
        </div>
        <p className="chat-file-observation">
          <strong>{t("message.630f02eff4ae")}</strong> {t("message.2aaef5696c80")}
        </p>
        {error && <p className="chat-file-error">{localizeText(error)}</p>}
      </div>
    </ModalDialog>
  );
}
