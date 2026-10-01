import { useDropdownPresence } from '../../hooks/useDropdownPresence';
import { useEffect, useRef, useState } from 'react';
import { Copy, Download, File, FolderSearch, Image as ImageIcon, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { ChatMessage } from '../../core/types';
import type { FileProgress } from '../../p2p/group_room';
import { selfId } from '@trystero-p2p/core';
import { formatFileSize } from '../../core/file_size';
import { FileProgressRing } from './FileProgressRing';
import { MAX_IMAGE_PREVIEW_BYTES } from '../../core/chat_file_limits';
import { Tooltip } from '../common/Tooltip';
import { showToast } from '../../hooks/useToast';
import { formatTransferSpeed, type TransferSpeedUnit } from '../../core/transfer_speed';
import { calculateFocalZoom, clampZoom } from './zoom_utils';

interface Props { message: ChatMessage; transfers: FileProgress[]; preview?: string; savedRequestId?: string;
  speedUnit: TransferSpeedUnit;
  onRequest: (saveAs: boolean) => void; onPreview: () => void; onCancel: (id: string) => void;
  onReveal: (id: string) => void }

export function ChatFileAttachment({ message, transfers, preview, savedRequestId, speedUnit, onRequest, onPreview, onCancel, onReveal }: Props) {
  const [menu, setMenu] = useState(false);
  const [menuBelow, setMenuBelow] = useState(false);
  const [viewer, setViewer] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const downloadWrap = useRef<HTMLDivElement>(null);
  const file = message.file!;
  const receiving = transfers.find((transfer) => transfer.direction === 'receive' && !transfer.previewOnly &&
    (transfer.status === 'pending' || transfer.status === 'active'));
  const menuPresence = useDropdownPresence(menu && !receiving ? true : null);
  const previewTransfer = transfers.find((transfer) => transfer.direction === 'receive' && transfer.previewOnly &&
    (transfer.status === 'pending' || transfer.status === 'active'));
  const sending = transfers.filter((transfer) => transfer.direction === 'send' && transfer.status === 'active');
  const completed = transfers.find((transfer) => transfer.direction === 'receive' && transfer.previewOnly && transfer.status === 'complete');
  const image = preview ?? completed?.preview;
  const own = message.authorId === selfId;
  const stageRef = useRef<HTMLDivElement>(null);
  const setImageZoom = (next: number, pointer?: { x: number; y: number }) => {
    const bounded = clampZoom(next);
    if (bounded !== 1 && pointer && stageRef.current) {
      const rect = stageRef.current.getBoundingClientRect();
      const result = calculateFocalZoom({ currentZoom: zoom, nextZoom: bounded,
        cursorX: pointer.x - rect.left, cursorY: pointer.y - rect.top,
        containerWidth: rect.width, containerHeight: rect.height, currentPan: pan });
      setPan(result.pan);
    }
    setZoom(bounded);
    if (bounded === 1) { setPan({ x: 0, y: 0 }); drag.current = null; }
  };
  const copyHash = () => {
    void navigator.clipboard.writeText(file.sha256)
      .then(() => showToast('Assinatura copiada!'))
      .catch(() => showToast('Não foi possível copiar a assinatura.'));
  };
  useEffect(() => {
    if (!viewer) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setViewer(false); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [viewer]);
  useEffect(() => {
    if (!viewer || !stageRef.current) return;
    const stage = stageRef.current;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      setImageZoom(zoom + (event.deltaY < 0 ? .25 : -.25), { x: event.clientX, y: event.clientY });
    };
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => stage.removeEventListener('wheel', wheel);
  }, [viewer, zoom, pan]);
  return <div className="chat-file-card">
    {file.isImage && image && <button className="chat-file-image-button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); setViewer(true); }} aria-label={`Ampliar ${file.name}`}>
      <img src={image} alt={file.name} /></button>}
    {file.isImage && !image && <div className="chat-file-preview-placeholder">
      {previewTransfer ? <FileProgressRing pending={previewTransfer.status === 'pending'}
        progress={previewTransfer.total ? previewTransfer.bytes / previewTransfer.total : 0}
        label="Cancelar solicitação de prévia" onCancel={() => onCancel(previewTransfer.requestId)} /> :
        !own && file.size <= MAX_IMAGE_PREVIEW_BYTES ? <button type="button" className="chat-file-preview-request"
          aria-label={`Baixar prévia de ${file.name}`} onClick={onPreview}><Download size={20} /></button> :
          <ImageIcon size={22} aria-hidden="true" />}
      <span>{previewTransfer?.status === 'pending' ? 'Solicitação enviada' :
        previewTransfer?.status === 'active' ?
          `Baixando prévia · ${formatTransferSpeed(previewTransfer.bytesPerSecond ?? 0, speedUnit)}` :
        file.size > MAX_IMAGE_PREVIEW_BYTES ? 'Prévia indisponível' : 'Baixar prévia'}</span>
    </div>}
    <div className="chat-file-card-row">
      {file.isImage ? <ImageIcon size={19} /> : <File size={19} />}
      <div className="chat-file-card-info"><strong>{file.name}</strong>
        <span className="chat-file-meta">{formatFileSize(file.size)} · <span className="chat-file-hash">{file.sha256.slice(0, 16)}…</span>
          <Tooltip content={file.sha256} compact={false} tooltipClassName="chat-file-hash-tooltip"><button type="button"
            className="chat-file-copy-hash" aria-label="Copiar assinatura completa" onClick={copyHash}><Copy size={12} /></button></Tooltip></span>
        {receiving && <small>{receiving.status === 'pending' ? 'Solicitação enviada' :
          `${Math.round(receiving.total ? receiving.bytes / receiving.total * 100 : 100)}% · ${formatFileSize(receiving.bytes)} de ${formatFileSize(receiving.total)} · ${formatTransferSpeed(receiving.bytesPerSecond ?? 0, speedUnit)}`}</small>}
        {sending.map((transfer) => <small key={transfer.requestId}>Para {transfer.peerName ?? 'participante'} ·
          {' '}{formatFileSize(transfer.bytes)} de {formatFileSize(transfer.total)} ·
          {' '}{formatTransferSpeed(transfer.bytesPerSecond ?? 0, speedUnit)}</small>)}
        {!receiving && savedRequestId && <small>Download concluído</small>}</div>
      {!own && <div className="chat-file-download-wrap" ref={downloadWrap}>
        {savedRequestId && <Tooltip content="Mostrar na pasta"><button type="button" className="chat-file-reveal-button"
          aria-label="Mostrar arquivo na pasta" onClick={() => onReveal(savedRequestId)}><FolderSearch size={16} /></button></Tooltip>}
        {receiving ? <FileProgressRing pending={receiving.status === 'pending'}
          progress={receiving.total ? receiving.bytes / receiving.total : 0}
          label="Cancelar download" onCancel={() => onCancel(receiving.requestId)} /> :
          <button className="chat-file-download-button" aria-label="Download" aria-expanded={menu} onClick={() => {
            setMenuBelow((downloadWrap.current?.getBoundingClientRect().top ?? 0) < 130);
            setMenu(!menu);
          }}><Download size={17} /></button>}
        {menuPresence.value && <div className={`chat-file-download-menu ${menuBelow ? 'is-below' : ''} ${menuPresence.closing ? 'dropdown-closing' : ''}`} inert={menuPresence.closing} aria-hidden={menuPresence.closing}>
          <button onClick={() => { setMenu(false); onRequest(false); }}>Salvar</button>
          <button onClick={() => { setMenu(false); onRequest(true); }}>Salvar Como</button>
        </div>}
      </div>}
    </div>
    {viewer && image && <div className="chat-image-viewer" role="dialog" aria-modal="true" aria-label={file.name}
      onClick={(event) => { if (event.target === event.currentTarget) setViewer(false); }}>
      <div className="chat-image-viewer-toolbar"><span>{file.name}</span>
        <button className="btn-stream-fullscreen" aria-label="Reduzir" onClick={() => setImageZoom(zoom - .25)}><ZoomOut size={16} /></button>
        <span>{Math.round(zoom * 100)}%</span>
        <button className="btn-stream-fullscreen" aria-label="Ampliar" onClick={() => setImageZoom(zoom + .25)}><ZoomIn size={16} /></button>
        <button className="btn-stream-fullscreen" aria-label="Fechar" onClick={() => setViewer(false)}><X size={16} /></button></div>
      <div className="chat-image-viewer-stage" ref={stageRef}
        onClick={(event) => { if (event.target === event.currentTarget) setViewer(false); }}><img src={image} alt={file.name}
        draggable={false} className={zoom > 1 ? 'is-zoomed' : ''}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        onPointerDown={(event) => { if (zoom <= 1) return; event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; }}
        onPointerMove={(event) => { if (!drag.current) return;
          setPan({ x: drag.current.panX + event.clientX - drag.current.x,
            y: drag.current.panY + event.clientY - drag.current.y }); }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} /></div>
    </div>}
  </div>;
}
