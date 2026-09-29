import { useRoom } from '../../hooks/useRoom';

export function ChatFileRequests() {
  const { fileRequests, fileProgress, answerFileRequest, cancelFileTransfer } = useRoom();
  const sending = Object.values(fileProgress).filter((item) => item.direction === 'send' && item.status === 'active');
  if (!fileRequests.length && !sending.length) return null;
  return <div className="chat-file-toasts" aria-live="polite">
    {fileRequests.map((request) => <div className="chat-file-toast" key={request.requestId}>
      <strong>{request.peerName} quer {request.preview ? 'visualizar' : 'baixar'} {request.name}</strong>
      <span>Arquivo local: {request.path}</span>
      <div><button onClick={() => void answerFileRequest(request.requestId, false)}>Recusar</button>
        <button className="btn-primary" onClick={() => void answerFileRequest(request.requestId, true)}>Enviar</button></div>
    </div>)}
    {sending.map((transfer) => <div className="chat-file-toast" key={transfer.requestId}>
      <strong>Enviando arquivo</strong><span>{Math.round(transfer.total ? transfer.bytes / transfer.total * 100 : 100)}%</span>
      <progress value={transfer.bytes} max={transfer.total || 1} />
      <button onClick={() => void cancelFileTransfer(transfer.requestId)}>Cancelar</button>
    </div>)}
  </div>;
}
