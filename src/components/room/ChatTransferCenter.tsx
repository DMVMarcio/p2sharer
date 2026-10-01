import { useDropdownPresence } from '../../hooks/useDropdownPresence';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Download, File, FolderSearch, Image as ImageIcon, Square, Upload, X } from 'lucide-react';
import { useRoom } from '../../hooks/useRoom';
import { showToast } from '../../hooks/useToast';
import { formatFileSize } from '../../core/file_size';
import type { FileProgress } from '../../p2p/group_room';
import { formatTransferSpeed, getTransferSpeedUnit, subscribeTransferSpeedUnit,
  type TransferSpeedUnit } from '../../core/transfer_speed';

function statusText(transfer: FileProgress, unit: TransferSpeedUnit): string {
  switch (transfer.status) {
    case 'pending': return 'Solicitação enviada';
    case 'active': return `${Math.round(transfer.total ? transfer.bytes / transfer.total * 100 : 100)}% · ${formatFileSize(transfer.bytes)} de ${formatFileSize(transfer.total)} · ${formatTransferSpeed(transfer.bytesPerSecond ?? 0, unit)}`;
    case 'complete': return 'Concluído';
    case 'cancelled': return 'Cancelado';
    case 'error': return 'Falhou';
  }
}

function timingText(transfer: FileProgress): string | null {
  const timings = transfer.timings;
  if (!timings || transfer.status === 'pending') return null;
  const seconds = (value: number) => `${(value / 1000).toFixed(1)} s`;
  return transfer.direction === 'send' ?
    `Leitura ${seconds(timings.readMs)} · Preparação ${seconds(timings.prepareMs)} · Canal ${seconds(timings.wireMs)}` :
    `Verificação ${seconds(timings.verifyMs)} · Escrita ${seconds(timings.writeMs)} · ACK ${seconds(timings.ackMs)}`;
}

function transportText(transfer: FileProgress, unit: TransferSpeedUnit): string | null {
  const details = transfer.transport;
  if (!details) return null;
  const parts: string[] = [];
  if (details.channelLabel === 'chat_file_bulk_v1') parts.push('Canal dedicado');
  if (details.protocol) parts.push(details.protocol.toUpperCase());
  if (details.localCandidateType && details.remoteCandidateType) {
    parts.push(`${details.localCandidateType} → ${details.remoteCandidateType}`);
  }
  if (details.pairBytesPerSecond !== undefined) {
    parts.push(`WebRTC ${formatTransferSpeed(details.pairBytesPerSecond, unit)}`);
  }
  if (transfer.direction === 'send' && details.queuedBytes !== undefined && details.queueLimitBytes !== undefined) {
    parts.push(`Fila ${formatFileSize(details.queuedBytes)} · limiar ${formatFileSize(details.queueLimitBytes)}`);
  }
  if (details.packetsDiscardedOnSend) parts.push(`${details.packetsDiscardedOnSend} pacotes descartados`);
  return parts.length ? parts.join(' · ') : null;
}

export function ChatTransferCenter() {
  const { fileProgress, cancelFileTransfer, dismissFileProgress, revealSavedFile } = useRoom();
  const [open, setOpen] = useState<'send' | 'receive' | null>(null);
  const presence = useDropdownPresence(open);
  const speedUnit = useSyncExternalStore(subscribeTransferSpeedUnit, getTransferSpeedUnit);
  const root = useRef<HTMLDivElement>(null);
  const all = Object.values(fileProgress);
  const visible = all.filter((item) => item.direction === presence.value)
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
    {presence.value && <div key={presence.value} className={`chat-transfer-menu ${presence.closing ? 'dropdown-closing' : ''}`} inert={presence.closing} aria-hidden={presence.closing} role="dialog" aria-label={presence.value === 'send' ? 'Envios de arquivos' : 'Downloads de arquivos'}>
      <strong className="chat-transfer-title">{presence.value === 'send' ? 'Envios' : 'Downloads'}</strong>
      {visible.length === 0 ? <p className="chat-transfer-empty">Nenhum arquivo nesta sala.</p> :
        <div className="chat-transfer-list">{visible.map((transfer) => <div className="chat-transfer-item" key={transfer.requestId}>
          <span className="chat-transfer-file-icon" aria-hidden="true">
            {transfer.isImage || transfer.previewOnly ? <ImageIcon size={18} /> : <File size={18} />}
          </span>
          <div className="chat-transfer-item-copy">
            <strong>{transfer.fileName ?? 'Arquivo'}{transfer.previewOnly ? ' · Prévia' : ''}</strong>
            <span>{presence.value === 'send' ? 'Para' : 'De'} {transfer.peerName ?? 'Participante'}</span>
            <small>{statusText(transfer, speedUnit)}</small>
            {transfer.connectionType && <small>{transfer.connectionType}
              {transfer.rttMs !== null && transfer.rttMs !== undefined ? ` · ${transfer.rttMs} ms` : ''}</small>}
            {transportText(transfer, speedUnit) && <small>{transportText(transfer, speedUnit)}</small>}
            {timingText(transfer) && <small>{timingText(transfer)}</small>}
          </div>
          {transfer.status === 'complete' && transfer.direction === 'receive' && transfer.saved &&
            <button type="button" aria-label="Mostrar arquivo na pasta" title="Mostrar na pasta"
              onClick={() => void revealSavedFile(transfer.messageId, transfer.requestId)
                .catch(() => showToast('O arquivo não está mais disponível na pasta.'))}><FolderSearch size={15} /></button>}
          {transfer.status === 'pending' || transfer.status === 'active' ?
            <button type="button" aria-label="Cancelar transferência" onClick={() => void cancelFileTransfer(transfer.requestId)}><Square size={13} fill="currentColor" /></button> :
            <button type="button" aria-label="Remover do histórico" onClick={() => dismissFileProgress(transfer.requestId)}><X size={14} /></button>}
        </div>)}</div>}
    </div>}
  </div>;
}
