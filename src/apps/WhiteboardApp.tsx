import { useEffect, useState } from 'react';
import { useLocale } from '../hooks/useLocale';
import { useRoom } from '../hooks/useRoom';
import { showToast } from '../hooks/useToast';
import { t } from '../i18n';
import { roomAppsService } from './room_apps_service';
import type { WhiteboardModel } from './whiteboard_model';
import { DEFAULT_BOARD_LAYER, type BoardLayer } from './whiteboard_scene';
import { WhiteboardToolbar, type BoardSettings } from './WhiteboardToolbar';
import { WhiteboardLayers } from './WhiteboardLayers';
import { WhiteboardCanvas } from './WhiteboardCanvas';
import { BOARD_HEIGHT, BOARD_WIDTH, containBoardLayer, type BoardViewport } from './whiteboard_interaction';
import { prepareWhiteboardImage, readClipboardImageDataUrl } from './whiteboard_image';
import { useElementFullscreen } from '../hooks/useElementFullscreen';
import { Maximize, Minimize } from 'lucide-react';
import { TooltipButton } from '../components/common/TooltipButton';
import { boardError, useWhiteboardFiles } from './useWhiteboardFiles';

export function WhiteboardApp({ instanceId, compact = false }: { instanceId: string; compact?: boolean }) {
  useLocale();
  const { username, peers } = useRoom();
  const model = roomAppsService.getModel<WhiteboardModel>(instanceId);
  const [, refresh] = useState(0);
  const [settings, setSettings] = useState<BoardSettings>(() => ({
    tool: 'pointer',
    brushType: 'brush',
    color: '#3b82f6',
    width: 1,
    opacity: 100,
    filled: false,
    smoothing: (() => {
      try { const value = Number(localStorage.getItem('p2sharer_whiteboard_smoothing') ?? 35); return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 35; } catch { return 35; }
    })(),
  }));
  const [activeLayer, setActiveLayer] = useState(DEFAULT_BOARD_LAYER);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewport, setViewport] = useState<BoardViewport>({ x: 60, y: 60, zoom: 1 });
  const { ref: fullscreenRef, fullscreen, toggleFullscreen } = useElementFullscreen<HTMLDivElement>();
  compact = compact && !fullscreen;
  const files = useWhiteboardFiles(model, instanceId);
  useEffect(() => roomAppsService.subscribe(() => refresh(n => n + 1)), []);
  const error = (reason: unknown) => showToast(boardError(reason), 3500, 'error');
  const updateLayer = (layer: BoardLayer) => { try { model?.updateLayer(layer); } catch (reason) { error(reason); } };
  const select = (id: string | null) => { setSelected(id); if (id) setActiveLayer(id); };
  const remove = (id: string) => { try { model?.removeLayer(id); setSelected(null); } catch (reason) { error(reason); } };
  const currentLayer = model?.layers.some(l => l.id === activeLayer) ? activeLayer : model?.layers[0]?.id ?? DEFAULT_BOARD_LAYER;
  const pasteImage = async (clipboardData?: DataTransfer | null) => {
    if (!model || compact) return;
    try {
      const dataUrl = await readClipboardImageDataUrl(clipboardData);
      const image = await prepareWhiteboardImage(dataUrl);
      const canvasEl = fullscreenRef.current?.querySelector('.whiteboard-canvas') as HTMLElement | null;
      const viewW = (canvasEl?.clientWidth || 800) / viewport.zoom;
      const viewH = (canvasEl?.clientHeight || 500) / viewport.zoom;
      const centerX = Math.max(0, Math.min(BOARD_WIDTH, (-viewport.x) / viewport.zoom + viewW / 2));
      const centerY = Math.max(0, Math.min(BOARD_HEIGHT, (-viewport.y) / viewport.zoom + viewH / 2));
      const maxW = Math.min(BOARD_WIDTH * 0.8, Math.max(240, viewW * 0.65));
      const maxH = Math.min(BOARD_HEIGHT * 0.8, Math.max(240, viewH * 0.65));
      const scale = Math.min(1, maxW / image.width, maxH / image.height);
      const width = Math.max(24, Math.round(image.width * scale));
      const height = Math.max(24, Math.round(image.height * scale));
      const x = Math.max(0, Math.min(BOARD_WIDTH - width, Math.round(centerX - width / 2)));
      const y = Math.max(0, Math.min(BOARD_HEIGHT - height, Math.round(centerY - height / 2)));
      const current = model.layers.find(l => l.id === currentLayer);
      const currentHasShapes = model.shapes.some(s => (s.layerId ?? DEFAULT_BOARD_LAYER) === currentLayer);
      const reuseCurrent = Boolean(current && !current.locked && !current.hidden && !currentHasShapes);
      const targetLayerId = reuseCurrent ? currentLayer : crypto.randomUUID();
      const newLayerName = reuseCurrent ? undefined : t('whiteboard.layerName', { index: model.layers.length + 1 });
      model.pasteImage(image, { x, y, width, height }, targetLayerId, newLayerName);
      setActiveLayer(targetLayerId);
      setSelected(targetLayerId);
      setSettings(prev => ({ ...prev, tool: 'pointer' }));
    } catch (reason) {
      error(reason);
    }
  };
  if (!model) return null;
  return <div ref={fullscreenRef} className="whiteboard-app" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onPaste={event => {
      if (compact || (event.target as HTMLElement).closest('input, textarea, [contenteditable], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      event.preventDefault();
      void pasteImage(event.clipboardData);
    }}
    onKeyDown={event => {
      if (compact || (event.target as HTMLElement).closest('input, textarea, [contenteditable], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if (mod && key === 's') { event.preventDefault(); void files.save(); }
      else if (mod && key === 'v') { event.preventDefault(); void pasteImage(); }
      else if (mod && (key === 'z' || key === 'y')) { event.preventDefault(); if (key === 'y' || event.shiftKey) model.redo(); else model.undo(); }
      else if (event.target instanceof HTMLElement && event.target.classList.contains('whiteboard-canvas')) {
        if (key === 'delete' || key === 'backspace') { event.preventDefault(); if (selected) remove(selected); }
        if (key === 'escape') setSelected(null);
        const layer = model.layers.find(l => l.id === selected);
        if (layer && !layer.locked && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault(); const step = event.shiftKey ? 10 : 1;
          updateLayer(containBoardLayer({ ...layer, x: layer.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
            y: layer.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) }, model.shapes));
        }
      }
    }}>
    {!compact && <><div className="whiteboard-file-actions">{files.actions}
      <TooltipButton tooltip={t(fullscreen ? 'browser.exitFullscreen' : 'browser.fullscreen')} aria-pressed={fullscreen} className="room-app-notepad-tool" onClick={() => void toggleFullscreen().catch(error)}>{fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}</TooltipButton>
    </div>{files.status}</>}
    <div className="whiteboard-workspace">
      <div className="whiteboard-stage">
    {!compact && <WhiteboardToolbar settings={settings} onChange={next => {
      setSettings(next);
      try { localStorage.setItem('p2sharer_whiteboard_smoothing', String(next.smoothing)); } catch { /* Keep the current session preference. */ }
    }} canUndo={model.history.canUndo()} canRedo={model.history.canRedo()} onUndo={() => model.undo()} onRedo={() => model.redo()} onPasteImage={() => void pasteImage()}
      />}
      <WhiteboardCanvas model={model} activeLayer={currentLayer} settings={settings} viewport={viewport} onViewport={setViewport} selected={selected} onSelect={select}
        compact={compact} actor={roomAppsService.getLocalActor()} name={username} onError={error} onPasteImage={() => void pasteImage()}
        participantName={actor => peers.find(peer => peer.id === actor)?.username || t('browser.participant')} />
      </div>
      {!compact && <WhiteboardLayers layers={model.layers} shapes={model.shapes} active={currentLayer} onActivate={select} onChange={updateLayer} onDelete={remove}
        imageHref={hash => model.imageUrl(hash)}
        onAdd={() => { try { const id = model.addLayer(t('whiteboard.layerName', { index: model.layers.length + 1 })); setActiveLayer(id); setSelected(null); } catch (reason) { error(reason); } }}
        onReorder={ids => { try { model.reorderLayers(ids); } catch (reason) { error(reason); } }} />}
    </div>
    {!compact && files.dialogs}
  </div>;
}
