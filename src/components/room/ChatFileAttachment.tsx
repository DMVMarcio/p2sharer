import { useEffect, useRef, useState } from 'react';
import { Download, File, Image as ImageIcon, Square, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { ChatMessage } from '../../core/types';
import type { FileProgress } from '../../p2p/group_room';
import { selfId } from '@trystero-p2p/core';

interface Props { message: ChatMessage; transfers: FileProgress[]; preview?: string;
  onRequest: (saveAs: boolean) => void; onCancel: (id: string) => void }

export function ChatFileAttachment({ message, transfers, preview, onRequest, onCancel }: Props) {
  const [menu, setMenu] = useState(false);
  const [viewer, setViewer] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const file = message.file!;
  const receiving = transfers.find((transfer) => transfer.direction === 'receive' &&
    (transfer.status === 'pending' || transfer.status === 'active'));
  const completed = transfers.find((transfer) => transfer.direction === 'receive' && transfer.status === 'complete');
  const image = preview ?? completed?.preview;
  const own = message.authorId === selfId;
  useEffect(() => {
    if (!viewer) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setViewer(false); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [viewer]);
  return <div className="chat-file-card">
    {file.isImage && image && <button className="chat-file-image-button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); setViewer(true); }} aria-label={`Ampliar ${file.name}`}>
      <img src={image} alt={file.name} /></button>}
    <div className="chat-file-card-row">
      {file.isImage ? <ImageIcon size={19} /> : <File size={19} />}
      <div className="chat-file-card-info"><strong>{file.name}</strong><span>{(file.size / 1024).toFixed(1)} KB · SHA-256 {file.sha256}</span></div>
      {!own && <div className="chat-file-download-wrap">
        {receiving ? <button className="chat-file-progress-button" aria-label="Cancelar download" onClick={() => onCancel(receiving.requestId)}
          style={{ background: `conic-gradient(var(--accent-color) ${receiving.total ? receiving.bytes / receiving.total * 360 : 0}deg, var(--border-default) 0)` }}>
          <Square size={12} fill="currentColor" /></button> :
          <button className="chat-file-download-button" aria-label="Download" aria-expanded={menu} onClick={() => setMenu(!menu)}><Download size={17} /></button>}
        {menu && !receiving && <div className="chat-file-download-menu">
          <button onClick={() => { setMenu(false); onRequest(false); }}>Salvar</button>
          <button onClick={() => { setMenu(false); onRequest(true); }}>Salvar Como</button>
        </div>}
      </div>}
    </div>
    {viewer && image && <div className="chat-image-viewer" role="dialog" aria-modal="true" aria-label={file.name}
      onClick={(event) => { if (event.target === event.currentTarget) setViewer(false); }}
      onWheel={(event) => { event.preventDefault(); setZoom((value) => Math.min(5, Math.max(1, value + (event.deltaY < 0 ? .25 : -.25)))); }}>
      <div className="chat-image-viewer-toolbar"><span>{file.name}</span>
        <button aria-label="Reduzir" onClick={() => setZoom((value) => Math.max(1, value - .25))}><ZoomOut size={18} /></button>
        <span>{Math.round(zoom * 100)}%</span>
        <button aria-label="Ampliar" onClick={() => setZoom((value) => Math.min(5, value + .25))}><ZoomIn size={18} /></button>
        <button aria-label="Fechar" onClick={() => setViewer(false)}><X size={18} /></button></div>
      <div className="chat-image-viewer-stage"><img src={image} alt={file.name}
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
