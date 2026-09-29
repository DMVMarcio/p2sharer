import { useEffect, useRef, useState } from 'react';
import { Download, Square, Upload, X } from 'lucide-react';
import { useRoom } from '../../hooks/useRoom';
import { formatFileSize } from '../../core/file_size';
import type { FileProgress } from '../../p2p/group_room';

function statusText(transfer: FileProgress): string {
  switch (transfer.status) {
    case 'pending': return 'Solicitação enviada';
    case 'active': return `${Math.round(transfer.total ? transfer.bytes / transfer.total * 100 : 100)}% · ${formatFileSize(transfer.bytes)} de ${formatFileSize(transfer.total)}`;
    case 'complete': return 'Concluído';
    case 'cancelled': return 'Cancelado';
    case 'error': return 'Falhou';
  }
}

export function ChatTransferCenter() {
  const { fileProgress, cancelFileTransfer, dismissFileProgress } = useRoom();
  const [open, setOpen] = useState<'send' | 'receive' | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const all = Object.values(fileProgress);
  const visible = all.filter((item) => item.direction === open)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(null); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(null); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, [open]);
  return <div className="chat-transfer-center" ref={root}>
    {(['send', 'receive'] as const).map((direction) => {
      const active = all.filter((item) => item.direction === direction &&
        (item.status === 'pending' || item.status === 'active')).length;
      const label = direction === 'send' ? 'Envios' : 'Downloads';
      return <button key={direction} type="button" className={`btn-chat-transfer ${open === direction ? 'active' : ''}`}
        aria-label={label} aria-expanded={open === direction}
        onClick={() => setOpen((current) => current === direction ? null : direction)}>
        {direction === 'send' ? <Upload size={17} /> : <Download size={17} />}
        {active > 0 && <span className="chat-transfer-count">{active}</span>}
      </button>;
    })}
    {open && <div className="chat-transfer-menu" role="dialog" aria-label={open === 'send' ? 'Envios de arquivos' : 'Downloads de arquivos'}>
      <strong className="chat-transfer-title">{open === 'send' ? 'Envios' : 'Downloads'}</strong>
      {visible.length === 0 ? <p className="chat-transfer-empty">Nenhum arquivo nesta sala.</p> :
        <div className="chat-transfer-list">{visible.map((transfer) => <div className="chat-transfer-item" key={transfer.requestId}>
          <div className="chat-transfer-item-copy">
            <strong>{transfer.fileName ?? 'Arquivo'}{transfer.previewOnly ? ' · Prévia' : ''}</strong>
            <span>{open === 'send' ? 'Para' : 'De'} {transfer.peerName ?? 'Participante'}</span>
            <small>{statusText(transfer)}</small>
          </div>
          {transfer.status === 'pending' || transfer.status === 'active' ?
            <button type="button" aria-label="Cancelar transferência" onClick={() => void cancelFileTransfer(transfer.requestId)}><Square size={13} fill="currentColor" /></button> :
            <button type="button" aria-label="Remover do histórico" onClick={() => dismissFileProgress(transfer.requestId)}><X size={14} /></button>}
        </div>)}</div>}
    </div>}
  </div>;
}
