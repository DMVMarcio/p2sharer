import { useState } from 'react';
import type { NativeChatFile } from '../../p2p/group_room';
import { formatFileSize } from '../../core/file_size';
import { Paperclip } from 'lucide-react';

interface Props { file: NativeChatFile; onClose: () => void; onOffer: (name: string, autoAccept: boolean) => Promise<void> }

export function ChatFileOfferDialog({ file, onClose, onOffer }: Props) {
  const [name, setName] = useState(file.name);
  const [autoAccept, setAutoAccept] = useState(() => file.isImage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true);
    try { await onOffer(name.trim(), autoAccept); onClose(); }
    catch { setError('Confira o nome e se o arquivo ainda está acessível.'); }
    finally { setBusy(false); }
  };
  return <div className="modal-overlay" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <div className="modal-card chat-file-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-file-dialog-title">
      <div className="modal-header"><div className="modal-header-icon"><Paperclip size={19} /></div><div><h2 id="chat-file-dialog-title">Anexar arquivo</h2>
        <p className="modal-subtitle">O arquivo será oferecido no chat. Você decide quando enviá-lo.</p></div>
        <button className="btn-close" aria-label="Fechar" disabled={busy} onClick={onClose}>&times;</button></div>
      <div className="modal-body chat-file-dialog-body">
        <div className="form-group"><label className="form-label" htmlFor="chat-file-name">Nome exibido</label>
          <input autoComplete="off" className="text-input" id="chat-file-name" value={name} maxLength={180}
            onChange={(event) => setName(event.target.value)} /></div>
        <div className="chat-file-detail"><span>{formatFileSize(file.size)}</span><span>SHA-256 {file.hash}</span></div>
        <div className="chat-file-switch"><span>Aceitar solicitações</span>
          <label className="modern-switch"><input autoComplete="off" type="checkbox" checked={autoAccept}
            aria-label="Aceitar solicitações"
            onChange={(event) => setAutoAccept(event.target.checked)} /><span className="switch-slider" /></label></div>
        <p className="chat-file-observation"><strong>Obs:</strong> Ao ativar, todas as solicitações de download deste arquivo serão aceitas automaticamente pelos próximos 10 minutos.</p>
        {error && <p className="chat-file-error">{error}</p>}
      </div>
      <div className="modal-footer"><button className="btn btn-secondary" disabled={busy} onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void submit()}>Anexar</button></div>
    </div>
  </div>;
}
