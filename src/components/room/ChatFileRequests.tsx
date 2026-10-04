import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useRoom } from '../../hooks/useRoom';

export function ChatFileRequests() {
  useLocale();
  const { fileRequests, answerFileRequest } = useRoom();
  if (!fileRequests.length) return null;
  return <div className="chat-file-toasts" aria-live="polite">
    {fileRequests.map((request) => <div className="chat-file-toast" key={request.requestId}>
      <p className="chat-file-toast-title"><strong className="chat-file-toast-person">{request.peerName}</strong>
        {' '}{t("message.8f3e00408d22")} {request.preview ? t('files.previewVerb') : t('files.downloadVerb')}{' '}
        <strong className="chat-file-toast-name">{request.name}</strong></p>
      <span>{t("message.5af3f0720f4d")} {request.path}</span>
      <div><button onClick={() => void answerFileRequest(request.requestId, false)}>{t("message.ce432849d60e")}</button>
        <button className="btn-primary" onClick={() => void answerFileRequest(request.requestId, true)}>{t("message.e1d12d1a29a7")}</button></div>
    </div>)}
  </div>;
}
