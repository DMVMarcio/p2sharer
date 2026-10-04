import { getLanguage, localizeText, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
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
    case 'pending': return t('message.a6c8547e96c9');
    case 'active': return t('message.913cec09c978', { v0: Math.round(transfer.total ? transfer.bytes / transfer.total * 100 : 100), v1: formatFileSize(transfer.bytes), v2: formatFileSize(transfer.total), v3: formatTransferSpeed(transfer.bytesPerSecond ?? 0, unit) });
    case 'complete': return t('message.2801cb53f1fa');
    case 'cancelled': return t('message.f407384e2f30');
    case 'error': return t('message.253acf999f5d');
  }
}

function timingText(transfer: FileProgress): string | null {
  const timings = transfer.timings;
  if (!timings || transfer.status === 'pending') return null;
  const seconds = (value: number) => `${(value / 1000).toLocaleString(getLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
  return transfer.direction === 'send' ?
    t("message.3a61be37ee62", { v0: seconds(timings.readMs), v1: seconds(timings.prepareMs), v2: seconds(timings.wireMs) }) :
    t("message.b845b0cfe1b3", { v0: seconds(timings.verifyMs), v1: seconds(timings.writeMs), v2: seconds(timings.ackMs) });
}

function transportText(transfer: FileProgress, unit: TransferSpeedUnit): string | null {
  const details = transfer.transport;
  if (!details) return null;
  const parts: string[] = [];
  if (details.channelLabel === 'chat_file_bulk_v1') parts.push(t("message.928271cd163c"));
  if (details.protocol) parts.push(details.protocol.toUpperCase());
  if (details.localCandidateType && details.remoteCandidateType) {
    parts.push(`${details.localCandidateType} → ${details.remoteCandidateType}`);
  }
  if (details.pairBytesPerSecond !== undefined) {
    parts.push(`WebRTC ${formatTransferSpeed(details.pairBytesPerSecond, unit)}`);
  }
  if (transfer.direction === 'send' && details.queuedBytes !== undefined && details.queueLimitBytes !== undefined) {
    parts.push(t("message.022150087935", { v0: formatFileSize(details.queuedBytes), v1: formatFileSize(details.queueLimitBytes) }));
  }
  if (details.packetsDiscardedOnSend) parts.push(t("message.56ef2c33fdc6", { v0: details.packetsDiscardedOnSend }));
  return parts.length ? parts.join(' · ') : null;
}

export function ChatTransferCenter() {
  useLocale();
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
      const label = direction === 'send' ? t("message.0b1ee3b4ecdd") : t("common.downloads");
      return <button key={direction} type="button" className={`btn-chat-transfer ${open === direction ? 'active' : ''}`}
        aria-label={label} aria-expanded={open === direction}
        onClick={() => setOpen((current) => current === direction ? null : direction)}>
        {direction === 'send' ? <Upload size={17} /> : <Download size={17} />}
        {active > 0 && <span className="chat-transfer-count">{active}</span>}
      </button>;
    })}
    {presence.value && <div key={presence.value} className={`chat-transfer-menu ${presence.closing ? 'dropdown-closing' : ''}`} inert={presence.closing} aria-hidden={presence.closing} role="dialog" aria-label={presence.value === 'send' ? t("message.6c67c66d4c9c") : t("message.4e9e0fbfcfb3")}>
      <strong className="chat-transfer-title">{presence.value === 'send' ? t("message.0b1ee3b4ecdd") : t("common.downloads")}</strong>
      {visible.length === 0 ? <p className="chat-transfer-empty">{t("message.eec6ee5a72d8")}</p> :
        <div className="chat-transfer-list">{visible.map((transfer) => <div className="chat-transfer-item" key={transfer.requestId}>
          <span className="chat-transfer-file-icon" aria-hidden="true">
            {transfer.isImage || transfer.previewOnly ? <ImageIcon size={18} /> : <File size={18} />}
          </span>
          <div className="chat-transfer-item-copy">
            <strong>{transfer.fileName ?? t("message.ba8a452f2f83")}{transfer.previewOnly ? t("message.169a3563ed9b") : ''}</strong>
            <span>{presence.value === 'send' ? t("message.237b14cbb480") : t("message.e2eca64bd73c")} {transfer.peerName ?? t("message.1e97ddf60a0f")}</span>
            <small>{statusText(transfer, speedUnit)}</small>
            {transfer.connectionType && <small>{localizeText(transfer.connectionType)}
              {transfer.rttMs !== null && transfer.rttMs !== undefined ? ` · ${transfer.rttMs} ms` : ''}</small>}
            {transportText(transfer, speedUnit) && <small>{transportText(transfer, speedUnit)}</small>}
            {timingText(transfer) && <small>{timingText(transfer)}</small>}
          </div>
          {transfer.status === 'complete' && transfer.direction === 'receive' && transfer.saved &&
            <button type="button" aria-label={t("message.9392dee15ee6")} title={t("message.effbe5e6d9fb")}
              onClick={() => void revealSavedFile(transfer.messageId, transfer.requestId)
                .catch(() => showToast(t("message.bf86d73f16f0")))}><FolderSearch size={15} /></button>}
          {transfer.status === 'pending' || transfer.status === 'active' ?
            <button type="button" aria-label={t("message.01427c7bb274")} onClick={() => void cancelFileTransfer(transfer.requestId)}><Square size={13} fill="currentColor" /></button> :
            <button type="button" aria-label={t("message.fc1dca8fdd97")} onClick={() => dismissFileProgress(transfer.requestId)}><X size={14} /></button>}
        </div>)}</div>}
    </div>}
  </div>;
}
