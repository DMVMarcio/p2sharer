import { useEffect, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useLocale } from '../hooks/useLocale';
import { useRoom } from '../hooks/useRoom';
import { showToast } from '../hooks/useToast';
import { t } from '../i18n';
import { roomAppsService } from './room_apps_service';
import type { WhiteboardModel } from './whiteboard_model';
import { DEFAULT_BOARD_LAYER, type BoardLayer, type BoardTool } from './whiteboard_scene';
import { WhiteboardToolbar, type BoardSettings } from './WhiteboardToolbar';
import { WhiteboardLayers } from './WhiteboardLayers';
import { WhiteboardCanvas } from './WhiteboardCanvas';
import { BOARD_HEIGHT, BOARD_WIDTH, containBoardLayer, type BoardViewport } from './whiteboard_interaction';
import { prepareWhiteboardImage, readClipboardImageDataUrl } from './whiteboard_image';
import { useElementFullscreen } from '../hooks/useElementFullscreen';
import { Maximize, Minimize } from 'lucide-react';
import { TooltipButton } from '../components/common/TooltipButton';
import { boardError, useWhiteboardFiles } from './useWhiteboardFiles';

type WidthTool = 'brush' | 'eraser' | 'rectangle' | 'ellipse' | 'line';
const isWidthTool = (tool: BoardTool): tool is WidthTool =>
  tool === 'brush' || tool === 'eraser' || tool === 'rectangle' || tool === 'ellipse' || tool === 'line';

function loadToolWidths(): Record<WidthTool, number> {
  const defaults: Record<WidthTool, number> = { brush: 1, eraser: 1, rectangle: 1, ellipse: 1, line: 1 };
  try {
    const raw = localStorage.getItem('p2sharer_whiteboard_widths');
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Record<WidthTool, unknown>>;
    for (const key of Object.keys(defaults) as WidthTool[]) {
      const val = Number(parsed?.[key]);
      if (Number.isFinite(val)) defaults[key] = Math.max(1, Math.min(100, Math.round(val)));
    }
  } catch { /* ignore */ }
  return defaults;
}

const isBlockedShortcutTarget = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable], .ProseMirror, [role="textbox"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'));

export function WhiteboardApp({ instanceId, compact = false }: { instanceId: string; compact?: boolean }) {
  useLocale();
  const { username, peers } = useRoom();
  const model = roomAppsService.getModel<WhiteboardModel>(instanceId);
  const [, refresh] = useState(0);
  const toolWidthsRef = useRef<Record<WidthTool, number>>(loadToolWidths());
  const lastWidthToolRef = useRef<WidthTool>('brush');
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [settings, setSettings] = useState<BoardSettings>(() => ({
    tool: 'pointer',
    brushType: 'pencil',
    color: '#3b82f6',
    width: toolWidthsRef.current.brush,
    opacity: 100,
    filled: false,
    shapeFilled: { rectangle: false, ellipse: false },
    smoothing: (() => {
      try { const value = Number(localStorage.getItem('p2sharer_whiteboard_smoothing') ?? 35); return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 35; } catch { return 35; }
    })(),
  }));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const applySettings = (next: BoardSettings) => {
    setSettings(prev => {
      let width = next.width;
      const widthChanged = next.width !== prev.width;
      const toolChanged = next.tool !== prev.tool;
      if (toolChanged && isWidthTool(next.tool) && !widthChanged) {
        lastWidthToolRef.current = next.tool;
        width = toolWidthsRef.current[next.tool] ?? 1;
      } else if (widthChanged) {
        const targetTool = isWidthTool(next.tool) ? next.tool : lastWidthToolRef.current;
        toolWidthsRef.current = { ...toolWidthsRef.current, [targetTool]: next.width };
        try { localStorage.setItem('p2sharer_whiteboard_widths', JSON.stringify(toolWidthsRef.current)); } catch { /* ignore */ }
      } else if (isWidthTool(next.tool)) {
        lastWidthToolRef.current = next.tool;
      }
      try { localStorage.setItem('p2sharer_whiteboard_smoothing', String(next.smoothing)); } catch { /* Keep the current session preference. */ }
      return { ...next, width };
    });
  };
  const [activeLayer, setActiveLayer] = useState(DEFAULT_BOARD_LAYER);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewport, setViewport] = useState<BoardViewport>({ x: 60, y: 60, zoom: 1 });
  const { ref: fullscreenRef, fullscreen, toggleFullscreen } = useElementFullscreen<HTMLDivElement>();
  compact = compact && !fullscreen;
  const files = useWhiteboardFiles(model, instanceId);
  useEffect(() => roomAppsService.subscribe(() => refresh(n => n + 1)), []);
  useEffect(() => {
    if (compact) { setSpaceHeld(false); return; }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isBlockedShortcutTarget(event.target)) return;
      if (document.activeElement !== document.body && !fullscreenRef.current?.contains(document.activeElement)) return;
      if (fullscreenRef.current?.contains(event.target as Node)) return;
      const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if (!mod && !event.altKey) {
        if (event.code === 'Space' || event.key === ' ') {
          event.preventDefault();
          if (!event.repeat) setSpaceHeld(true);
        } else if (!event.repeat) {
          if (key === 'b') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'brush' }); }
          else if (key === 'e') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'eraser' }); }
          else if (key === 'v') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'pointer' }); }
          else if (key === 'r') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'rectangle', filled: settingsRef.current.shapeFilled?.rectangle ?? false }); }
          else if (key === 'o' || key === 'c') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'ellipse', filled: settingsRef.current.shapeFilled?.ellipse ?? false }); }
          else if (key === 'l') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'line' }); }
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space' || event.key === ' ') setSpaceHeld(false);
    };
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [compact, fullscreenRef]);
  const error = (reason: unknown) => showToast(boardError(reason), 3500, 'error');
  const updateLayer = (layer: BoardLayer) => { try { model?.updateLayer(layer); } catch (reason) { error(reason); } };
  const select = (id: string | null) => { setSelected(id); if (id) setActiveLayer(id); };
  const remove = (id: string) => { try { model?.removeLayer(id); setSelected(null); } catch (reason) { error(reason); } };
  const currentLayer = model?.layers.some(l => l.id === activeLayer) ? activeLayer : model?.layers[0]?.id ?? DEFAULT_BOARD_LAYER;
  const pasteImage = async (
    clipboardData?: DataTransfer | null,
    dropPoint?: { clientX: number; clientY: number },
    filePath?: string,
  ) => {
    if (!model || compact) return;
    try {
      const dataUrl = filePath ? undefined : await readClipboardImageDataUrl(clipboardData);
      const image = await prepareWhiteboardImage(dataUrl, filePath);
      const canvasEl = fullscreenRef.current?.querySelector('.whiteboard-canvas') as HTMLElement | null;
      const rect = canvasEl?.getBoundingClientRect();
      const viewW = (canvasEl?.clientWidth || 800) / viewport.zoom;
      const viewH = (canvasEl?.clientHeight || 500) / viewport.zoom;
      const centerX = dropPoint && rect
        ? Math.max(0, Math.min(BOARD_WIDTH, (dropPoint.clientX - rect.left - viewport.x) / viewport.zoom))
        : Math.max(0, Math.min(BOARD_WIDTH, (-viewport.x) / viewport.zoom + viewW / 2));
      const centerY = dropPoint && rect
        ? Math.max(0, Math.min(BOARD_HEIGHT, (dropPoint.clientY - rect.top - viewport.y) / viewport.zoom))
        : Math.max(0, Math.min(BOARD_HEIGHT, (-viewport.y) / viewport.zoom + viewH / 2));
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
  const pasteImageRef = useRef(pasteImage);
  pasteImageRef.current = pasteImage;
  useEffect(() => {
    if (compact || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(event => {
      if (disposed || event.payload.type !== 'drop' || !event.payload.paths.length) return;
      const canvasEl = fullscreenRef.current?.querySelector('.whiteboard-canvas') as HTMLElement | null;
      if (!canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const logical = { clientX: event.payload.position.x / dpr, clientY: event.payload.position.y / dpr };
      const raw = { clientX: event.payload.position.x, clientY: event.payload.position.y };
      const inside = (pt: { clientX: number; clientY: number }) =>
        pt.clientX >= rect.left && pt.clientX <= rect.right && pt.clientY >= rect.top && pt.clientY <= rect.bottom;
      const dropPoint = inside(logical) ? logical : inside(raw) ? raw : null;
      if (!dropPoint) return;
      void pasteImageRef.current(null, dropPoint, event.payload.paths[0]);
    }).then(fn => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [compact, fullscreenRef]);
  if (!model) return null;
  return <div ref={fullscreenRef} className="whiteboard-app" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onDragOver={event => {
      if (compact) return;
      const hasFiles = Array.from(event.dataTransfer?.types ?? []).includes('Files') ||
        Array.from(event.dataTransfer?.items ?? []).some(item => item.type.startsWith('image/'));
      if (hasFiles) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    }}
    onDrop={event => {
      if (compact) return;
      const hasImage = Array.from(event.dataTransfer?.files ?? []).some(file => file.type.startsWith('image/')) ||
        Array.from(event.dataTransfer?.items ?? []).some(item => item.type.startsWith('image/'));
      if (!hasImage) return;
      event.preventDefault();
      event.stopPropagation();
      void pasteImage(event.dataTransfer, { clientX: event.clientX, clientY: event.clientY });
    }}
    onPaste={event => {
      if (compact || isBlockedShortcutTarget(event.target)) return;
      event.preventDefault();
      void pasteImage(event.clipboardData);
    }}
    onKeyUp={event => {
      if (event.code === 'Space' || event.key === ' ') {
        if (!isBlockedShortcutTarget(event.target)) event.preventDefault();
        setSpaceHeld(false);
      }
    }}
    onKeyDown={event => {
      if (compact || isBlockedShortcutTarget(event.target)) return;
      const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if (!mod && !event.altKey && (event.code === 'Space' || event.key === ' ')) {
        event.preventDefault();
        if (!event.repeat) setSpaceHeld(true);
        return;
      }
      if (mod && key === 's') { event.preventDefault(); void files.save(); }
      else if (mod && key === 'v') { event.preventDefault(); void pasteImage(); }
      else if (mod && (key === 'z' || key === 'y')) { event.preventDefault(); if (key === 'y' || event.shiftKey) model.redo(); else model.undo(); }
      else if (!mod && !event.altKey && !event.repeat) {
        if (key === 'b') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'brush' }); return; }
        if (key === 'e') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'eraser' }); return; }
        if (key === 'v') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'pointer' }); return; }
        if (key === 'r') {
          event.preventDefault();
          applySettings({ ...settingsRef.current, tool: 'rectangle', filled: settingsRef.current.shapeFilled?.rectangle ?? false });
          return;
        }
        if (key === 'o' || key === 'c') {
          event.preventDefault();
          applySettings({ ...settingsRef.current, tool: 'ellipse', filled: settingsRef.current.shapeFilled?.ellipse ?? false });
          return;
        }
        if (key === 'l') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'line' }); return; }
      }
      if (event.target instanceof HTMLElement && event.target.classList.contains('whiteboard-canvas')) {
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
    {!compact && <WhiteboardToolbar settings={settings} onChange={applySettings}
      canUndo={model.history.canUndo()} canRedo={model.history.canRedo()} onUndo={() => model.undo()} onRedo={() => model.redo()} onPasteImage={() => void pasteImage()}
      />}
      <WhiteboardCanvas model={model} activeLayer={currentLayer} settings={settings} spaceHeld={spaceHeld} viewport={viewport} onViewport={setViewport} selected={selected} onSelect={select}
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
