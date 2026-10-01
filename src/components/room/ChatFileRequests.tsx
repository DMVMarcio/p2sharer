import { useRoom } from '../../hooks/useRoom';

export function ChatFileRequests() {
  const { fileRequests, answerFileRequest } = useRoom();
  if (!fileRequests.length) return null;
  return <div className="chat-file-toasts" aria-live="polite">
    {fileRequests.map((request) => <div className="chat-file-toast" key={request.requestId}>
      <p className="chat-file-toast-title"><strong className="chat-file-toast-person">{request.peerName}</strong>
        {' '}quer {request.preview ? 'visualizar' : 'baixar'}{' '}
        <strong className="chat-file-toast-name">{request.name}</strong></p>
      <span>Arquivo local: {request.path}</span>
      <div><button onClick={() => void answerFileRequest(request.requestId, false)}>Recusar</button>
        <button className="btn-primary" onClick={() => void answerFileRequest(request.requestId, true)}>Enviar</button></div>
    </div>)}
  </div>;
}
