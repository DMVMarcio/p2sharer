import { useState } from 'react';
import type { NativeChatFile } from '../../p2p/group_room';

interface Props { file: NativeChatFile; onClose: () => void; onOffer: (name: string, autoAccept: boolean) => Promise<void> }

export function ChatFileOfferDialog({ file, onClose, onOffer }: Props) {
  const [name, setName] = useState(file.name);
  const [autoAccept, setAutoAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true);
    try { await onOffer(name.trim(), autoAccept); onClose(); }
    catch { setError('Confira o nome e se o arquivo ainda está acessível.'); }
    finally { setBusy(false); }
  };
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-card chat-file-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-file-dialog-title">
      <div className="modal-header"><div><h2 id="chat-file-dialog-title">Anexar arquivo</h2>
        <p className="modal-subtitle">O arquivo será oferecido no chat. Você decide quando enviá-lo.</p></div>
        <button className="btn-close" aria-label="Fechar" onClick={onClose}>&times;</button></div>
      <div className="modal-body">
        <label className="chat-file-field">Nome exibido<input value={name} maxLength={180} onChange={(event) => setName(event.target.value)} /></label>
        <div className="chat-file-switch"><span>Aceitar solicitações automaticamente por 10 minutos</span>
          <label className="modern-switch"><input type="checkbox" checked={autoAccept}
            aria-label="Aceitar solicitações automaticamente por 10 minutos"
            onChange={(event) => setAutoAccept(event.target.checked)} /><span className="switch-slider" /></label></div>
        <p className="chat-file-detail">{(file.size / 1024).toFixed(1)} KB · SHA-256 {file.hash}</p>
        {error && <p className="chat-file-error">{error}</p>}
      </div>
      <div className="chat-file-dialog-actions"><button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void submit()}>Anexar</button></div>
    </div>
  </div>;
}
