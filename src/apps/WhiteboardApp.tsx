import { useEffect, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { ModalDialog } from '../components/common/ModalDialog';
import { Select } from '../components/common/Select';
import { useElementFullscreen } from '../hooks/useElementFullscreen';
import { useLocale } from '../hooks/useLocale';
import { useRoom } from '../hooks/useRoom';
import { showToast } from '../hooks/useToast';
import { t } from '../i18n';
import { roomAppsService } from './room_apps_service';
import type { WhiteboardModel } from './whiteboard_model';
import { DEFAULT_BOARD_LAYER, type BoardLayer, type BoardPoint, type BoardTool } from './whiteboard_scene';
import { WhiteboardToolbar, type BoardSettings } from './WhiteboardToolbar';
import { WhiteboardLayers } from './WhiteboardLayers';
import { WhiteboardCanvas } from './WhiteboardCanvas';
import { CANVAS_PRESETS, containBoardLayer, type BoardViewport } from './whiteboard_interaction';
import { prepareWhiteboardImage, readClipboardImageDataUrl } from './whiteboard_image';
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

function loadRecentColors(): string[] {
  try {
    const raw = localStorage.getItem('p2sharer_whiteboard_recent_colors');
    if (!raw) return ['#3b82f6', '#ef4444', '#22c55e', '#facc15', '#a855f7', '#000000', '#ffffff'];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((c): c is string => typeof c === 'string' && /^#[\da-f]{6}$/i.test(c)).slice(0, 12);
    }
  } catch { /* ignore */ }
  return ['#3b82f6', '#ef4444', '#22c55e', '#facc15', '#a855f7', '#000000', '#ffffff'];
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
  const [altHeld, setAltHeld] = useState(false);
  const [recentColors, setRecentColors] = useState<string[]>(loadRecentColors);
  const [selectionPolygon, setSelectionPolygon] = useState<BoardPoint[] | null>(null);
  const [canvasDialogOpen, setCanvasDialogOpen] = useState(false);

  const [settings, setSettings] = useState<BoardSettings>(() => ({
    tool: 'pointer',
    brushType: 'pencil',
    color: '#3b82f6',
    secondaryColor: '#ffffff',
    width: toolWidthsRef.current.brush,
    opacity: 100,
    flow: 100,
    hardness: 80,
    spacing: 15,
    pressureSize: true,
    pressureOpacity: true,
    filled: false,
    shapeFilled: { rectangle: false, ellipse: false },
    smoothing: (() => {
      try {
        const value = Number(localStorage.getItem('p2sharer_whiteboard_smoothing') ?? 35);
        return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 35;
      } catch {
        return 35;
      }
    })(),
    symmetry: 'none',
    fillTolerance: 32,
    fillExpand: 1,
    fillContiguous: true,
    fillAntiAlias: true,
    fillSample: 'layer',
    gradientType: 'linear',
    gradientTransparent: false,
    fontSize: 28,
    fontBold: false,
    fontItalic: false,
  }));

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const pushRecentColor = (hex: string) => {
    const normalized = hex.toLowerCase();
    setRecentColors(prev => {
      const next = [normalized, ...prev.filter(c => c.toLowerCase() !== normalized)].slice(0, 12);
      try { localStorage.setItem('p2sharer_whiteboard_recent_colors', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

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

  const error = (reason: unknown) => showToast(boardError(reason), 3500, 'error');
  const updateLayer = (layer: BoardLayer) => { try { model?.updateLayer(layer); } catch (reason) { error(reason); } };
  const select = (id: string | null) => { setSelected(id); if (id) setActiveLayer(id); };
  const remove = (id: string) => { try { model?.removeLayer(id); setSelected(null); } catch (reason) { error(reason); } };
  const currentLayer = model?.layers.some(l => l.id === activeLayer) ? activeLayer : model?.layers[0]?.id ?? DEFAULT_BOARD_LAYER;

  const selectAll = () => {
    if (!model) return;
    const { width, height } = model.canvasSettings;
    setSelectionPolygon([
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ]);
  };

  const clearSelection = () => setSelectionPolygon(null);

  const invertSelection = () => {
    if (!model || !selectionPolygon?.length) return;
    const { width, height } = model.canvasSettings;
    // If already an inverted keyhole polygon (starts with the 5 outer frame vertices), unwrap the inner polygon
    if (
      selectionPolygon.length > 7 &&
      selectionPolygon[0].x === 0 && selectionPolygon[0].y === 0 &&
      selectionPolygon[1].x === width && selectionPolygon[1].y === 0 &&
      selectionPolygon[2].x === width && selectionPolygon[2].y === height &&
      selectionPolygon[3].x === 0 && selectionPolygon[3].y === height &&
      selectionPolygon[4].x === 0 && selectionPolygon[4].y === 0
    ) {
      const inner = selectionPolygon.slice(5, -2);
      setSelectionPolygon(inner.length >= 3 ? inner : null);
      return;
    }
    // Construct an even-odd keyhole polygon connecting the outer board boundary to the inner selection contour
    const first = selectionPolygon[0];
    setSelectionPolygon([
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
      { x: 0, y: 0 },
      ...selectionPolygon,
      { x: first.x, y: first.y },
      { x: 0, y: 0 },
    ]);
  };

  const deleteSelectionPixels = () => {
    if (!model || !selectionPolygon?.length) return;
    try {
      model.clearLayer(currentLayer, selectionPolygon);
    } catch (reason) {
      error(reason);
    }
  };

  const fillSelectionPixels = () => {
    if (!model || !selectionPolygon?.length) return;
    const layer = model.layers.find(l => l.id === currentLayer);
    if (!layer || layer.locked || layer.hidden) return;
    try {
      const localPoly = selectionPolygon.map(p => ({
        x: Math.round((p.x - layer.x) * 100) / 100,
        y: Math.round((p.y - layer.y) * 100) / 100,
      }));
      model.put({
        id: crypto.randomUUID(),
        layerId: layer.id,
        tool: 'bucket',
        points: [localPoly[0]],
        clipPolygon: localPoly,
        color: settingsRef.current.color,
        width: 1,
        opacity: settingsRef.current.opacity,
        filled: true,
        x: 0,
        y: 0,
        order: (model.shapes[model.shapes.length - 1]?.order ?? 0) + 1,
        hidden: false,
        locked: false,
      });
    } catch (reason) {
      error(reason);
    }
  };

  useEffect(() => roomAppsService.subscribe(() => refresh(n => n + 1)), []);

  useEffect(() => {
    if (compact) { setSpaceHeld(false); setAltHeld(false); return; }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isBlockedShortcutTarget(event.target)) return;
      if (document.activeElement !== document.body && !fullscreenRef.current?.contains(document.activeElement)) return;
      if (event.target instanceof Node && fullscreenRef.current?.contains(event.target)) return;
      const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if (event.key === 'Alt' && !mod && !event.shiftKey) {
        event.preventDefault();
        if (!event.repeat) setAltHeld(true);
        return;
      }
      if (!mod && !event.altKey) {
        if (event.code === 'Space' || event.key === ' ') {
          event.preventDefault();
          if (!event.repeat) setSpaceHeld(true);
        } else if (!event.repeat) {
          if (key === 'b') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'brush' }); }
          else if (key === 'e') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'eraser' }); }
          else if (key === 'v') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'pointer' }); }
          else if (key === 'g') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'bucket' }); }
          else if (key === 'k') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'gradient' }); }
          else if (key === 'i') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'eyedropper' }); }
          else if (key === 'm') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'selectRect' }); }
          else if (key === 'w') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'wand' }); }
          else if (key === 't') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'text' }); }
          else if (key === 'x') {
            event.preventDefault();
            const cur = settingsRef.current;
            applySettings({ ...cur, color: cur.secondaryColor ?? '#ffffff', secondaryColor: cur.color });
          }
          else if (key === 'd') {
            event.preventDefault();
            applySettings({ ...settingsRef.current, color: '#000000', secondaryColor: '#ffffff' });
          }
          else if (key === 'r') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'rectangle', filled: settingsRef.current.shapeFilled?.rectangle ?? false }); }
          else if (key === 'o' || key === 'c') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'ellipse', filled: settingsRef.current.shapeFilled?.ellipse ?? false }); }
          else if (key === 'l') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'line' }); }
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space' || event.key === ' ') setSpaceHeld(false);
      if (event.key === 'Alt' || !event.altKey) setAltHeld(false);
    };
    const onBlur = () => {
      setSpaceHeld(false);
      setAltHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [compact, fullscreenRef]);

  const pasteImage = async (
    clipboardData?: DataTransfer | null,
    dropPoint?: { clientX: number; clientY: number },
    filePath?: string,
  ) => {
    if (!model || compact) return;
    try {
      const dataUrl = filePath ? undefined : await readClipboardImageDataUrl(clipboardData);
      const image = await prepareWhiteboardImage(dataUrl, filePath);
      const { width: boardWidth, height: boardHeight } = model.canvasSettings;
      const canvasEl = fullscreenRef.current?.querySelector('.whiteboard-canvas') as HTMLElement | null;
      const rect = canvasEl?.getBoundingClientRect();
      const viewW = (canvasEl?.clientWidth || 800) / viewport.zoom;
      const viewH = (canvasEl?.clientHeight || 500) / viewport.zoom;
      const centerX = dropPoint && rect
        ? Math.max(0, Math.min(boardWidth, (dropPoint.clientX - rect.left - viewport.x) / viewport.zoom))
        : Math.max(0, Math.min(boardWidth, (-viewport.x) / viewport.zoom + viewW / 2));
      const centerY = dropPoint && rect
        ? Math.max(0, Math.min(boardHeight, (dropPoint.clientY - rect.top - viewport.y) / viewport.zoom))
        : Math.max(0, Math.min(boardHeight, (-viewport.y) / viewport.zoom + viewH / 2));
      const maxW = Math.min(boardWidth * 0.8, Math.max(240, viewW * 0.65));
      const maxH = Math.min(boardHeight * 0.8, Math.max(240, viewH * 0.65));
      const scale = Math.min(1, maxW / image.width, maxH / image.height);
      const width = Math.max(24, Math.round(image.width * scale));
      const height = Math.max(24, Math.round(image.height * scale));
      const x = Math.max(0, Math.min(boardWidth - width, Math.round(centerX - width / 2)));
      const y = Math.max(0, Math.min(boardHeight - height, Math.round(centerY - height / 2)));
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

  return (
    <div
      ref={fullscreenRef}
      className="whiteboard-app"
      onClick={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
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
        if (event.key === 'Alt' || !event.altKey) {
          setAltHeld(false);
        }
      }}
      onKeyDown={event => {
        if (compact || isBlockedShortcutTarget(event.target)) return;
        const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
        if (event.key === 'Alt' && !mod && !event.shiftKey) {
          event.preventDefault();
          if (!event.repeat) setAltHeld(true);
          return;
        }
        if (!mod && !event.altKey && (event.code === 'Space' || event.key === ' ')) {
          event.preventDefault();
          if (!event.repeat) setSpaceHeld(true);
          return;
        }
        if (mod && key === 's') { event.preventDefault(); void files.save(); }
        else if (mod && key === 'v') { event.preventDefault(); void pasteImage(); }
        else if (mod && key === 'a') { event.preventDefault(); selectAll(); }
        else if (mod && key === 'd') { event.preventDefault(); clearSelection(); }
        else if (mod && event.shiftKey && key === 'i') { event.preventDefault(); invertSelection(); }
        else if (mod && (key === 'z' || key === 'y')) {
          event.preventDefault();
          if (key === 'y' || event.shiftKey) model.redo();
          else model.undo();
        } else if (!mod && !event.altKey && !event.repeat) {
          if (key === 'b') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'brush' }); return; }
          if (key === 'e') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'eraser' }); return; }
          if (key === 'v') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'pointer' }); return; }
          if (key === 'g') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'bucket' }); return; }
          if (key === 'k') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'gradient' }); return; }
          if (key === 'i') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'eyedropper' }); return; }
          if (key === 'm') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'selectRect' }); return; }
          if (key === 'w') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'wand' }); return; }
          if (key === 't') { event.preventDefault(); applySettings({ ...settingsRef.current, tool: 'text' }); return; }
          if (key === 'x') {
            event.preventDefault();
            const cur = settingsRef.current;
            applySettings({ ...cur, color: cur.secondaryColor ?? '#ffffff', secondaryColor: cur.color });
            return;
          }
          if (key === 'd') {
            event.preventDefault();
            applySettings({ ...settingsRef.current, color: '#000000', secondaryColor: '#ffffff' });
            return;
          }
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
          if (key === 'delete' || key === 'backspace') {
            event.preventDefault();
            if (selectionPolygon?.length) deleteSelectionPixels();
            else if (selected) remove(selected);
          }
          if (key === 'escape') {
            if (selectionPolygon?.length) setSelectionPolygon(null);
            else setSelected(null);
          }
          const layer = model.layers.find(l => l.id === selected);
          if (layer && !layer.locked && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
            event.preventDefault();
            const step = event.shiftKey ? 10 : 1;
            const { width: bw, height: bh } = model.canvasSettings;
            updateLayer(containBoardLayer({
              ...layer,
              x: layer.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
              y: layer.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),
            }, model.shapes, bw, bh));
          }
        }
      }}
    >
      <div className="whiteboard-workspace">
        <div className="whiteboard-stage">
          {!compact && (
            <WhiteboardToolbar
              settings={settings}
              onChange={applySettings}
              canUndo={model.history.canUndo()}
              canRedo={model.history.canRedo()}
              onUndo={() => model.undo()}
              onRedo={() => model.redo()}
              onPasteImage={() => void pasteImage()}
              hasSelection={Boolean(selectionPolygon?.length)}
              onSelectAll={selectAll}
              onClearSelection={clearSelection}
              onInvertSelection={invertSelection}
              onDeleteSelectionPixels={deleteSelectionPixels}
              onFillSelectionPixels={fillSelectionPixels}
              fileActions={files.actions}
              fileStatus={files.status}
              boardDimensions={`${model.canvasSettings.width}×${model.canvasSettings.height}`}
              altHeld={altHeld}
            />
          )}
          <WhiteboardCanvas
            model={model}
            activeLayer={currentLayer}
            settings={settings}
            spaceHeld={spaceHeld}
            altHeld={altHeld}
            viewport={viewport}
            onViewport={setViewport}
            selected={selected}
            onSelect={select}
            selectionPolygon={selectionPolygon}
            onSelectionChange={setSelectionPolygon}
            onPickColor={picked => {
              pushRecentColor(picked);
              applySettings({ ...settingsRef.current, color: picked });
            }}
            onOpenCanvasSettings={() => setCanvasDialogOpen(true)}
            fullscreen={fullscreen}
            onToggleFullscreen={() => void toggleFullscreen().catch(error)}
            compact={compact}
            actor={roomAppsService.getLocalActor()}
            name={username}
            onError={error}
            onPasteImage={() => void pasteImage()}
            participantName={actor => peers.find(peer => peer.id === actor)?.username || t('browser.participant')}
          />
        </div>
        {!compact && (
          <WhiteboardLayers
            layers={model.layers}
            shapes={model.shapes}
            active={currentLayer}
            onActivate={select}
            onChange={updateLayer}
            onDelete={remove}
            imageHref={hash => model.imageUrl(hash)}
            color={settings.color}
            secondaryColor={settings.secondaryColor ?? '#ffffff'}
            recentColors={recentColors}
            isEyedropper={altHeld || settings.tool === 'eyedropper'}
            onColorChange={color => applySettings({ ...settingsRef.current, color })}
            onSecondaryColorChange={secondaryColor => applySettings({ ...settingsRef.current, secondaryColor })}
            onCommitColor={pushRecentColor}
            onSwapColors={() => {
              const cur = settingsRef.current;
              applySettings({ ...cur, color: cur.secondaryColor ?? '#ffffff', secondaryColor: cur.color });
            }}
            onResetColors={() => applySettings({ ...settingsRef.current, color: '#000000', secondaryColor: '#ffffff' })}
            onPickEyedropper={() => applySettings({ ...settingsRef.current, tool: 'eyedropper' })}
            onAdd={() => {
              try {
                const id = model.addLayer(t('whiteboard.layerName', { index: model.layers.length + 1 }));
                setActiveLayer(id);
                setSelected(null);
              } catch (reason) {
                error(reason);
              }
            }}
            onDuplicate={id => {
              try {
                const src = model.layers.find(l => l.id === id);
                const baseName = src?.name || t('whiteboard.layerName', { index: model.layers.findIndex(l => l.id === id) + 1 });
                const newId = model.duplicateLayer(id, `${baseName} (2)`);
                setActiveLayer(newId);
              } catch (reason) {
                error(reason);
              }
            }}
            onMergeDown={id => {
              try {
                const mergedId = model.mergeLayerDown(id);
                if (mergedId) setActiveLayer(mergedId);
              } catch (reason) {
                error(reason);
              }
            }}
            onClearLayer={id => {
              try {
                model.clearLayer(id);
              } catch (reason) {
                error(reason);
              }
            }}
            onFlipLayer={(id, axis) => {
              try {
                model.flipLayer(id, axis);
              } catch (reason) {
                error(reason);
              }
            }}
            onReorder={ids => {
              try {
                model.reorderLayers(ids);
              } catch (reason) {
                error(reason);
              }
            }}
          />
        )}
      </div>
      {!compact && files.dialogs}
      {!compact && canvasDialogOpen && (
        <CanvasSettingsDialog
          model={model}
          onClose={() => setCanvasDialogOpen(false)}
          onError={error}
        />
      )}
    </div>
  );
}

function CanvasSettingsDialog({
  model,
  onClose,
  onError,
}: {
  model: WhiteboardModel;
  onClose(): void;
  onError(reason: unknown): void;
}) {
  const current = model.canvasSettings;
  const matchedPreset = CANVAS_PRESETS.find(p => p.width === current.width && p.height === current.height)?.id ?? 'custom';
  const [preset, setPreset] = useState(matchedPreset);
  const [width, setWidth] = useState(String(current.width));
  const [height, setHeight] = useState(String(current.height));
  const [bgColor, setBgColor] = useState(current.backgroundColor);
  const [transparent, setTransparent] = useState(current.transparent);

  const presetOptions = [
    ...CANVAS_PRESETS.map(p => ({ value: p.id, label: `${t(p.labelKey)} (${p.width}×${p.height})` })),
    { value: 'custom', label: t('whiteboard.canvasCustom') },
  ];

  return (
    <ModalDialog
      title={t('whiteboard.canvasSettings')}
      onClose={onClose}
      footer={close => (
        <>
          <button type="button" className="btn btn-secondary" onClick={close}>
            {t('message.bb9dbb406dcb')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              try {
                const w = Math.max(64, Math.min(4096, Math.round(Number(width) || 1920)));
                const h = Math.max(64, Math.min(4096, Math.round(Number(height) || 1080)));
                const validBg = /^#[\da-f]{6}$/i.test(bgColor) ? bgColor.toLowerCase() : '#ffffff';
                model.setCanvasSettings({ width: w, height: h, backgroundColor: validBg, transparent });
                close();
              } catch (err) {
                onError(err);
              }
            }}
          >
            {t('notepad.save')}
          </button>
        </>
      )}
    >
      <div className="whiteboard-canvas-settings-form">
        <label className="form-label">{t('whiteboard.canvasPreset')}</label>
        <Select
          aria-label={t('whiteboard.canvasPreset')}
          value={preset}
          options={presetOptions}
          onValueChange={val => {
            setPreset(val);
            const found = CANVAS_PRESETS.find(p => p.id === val);
            if (found) {
              setWidth(String(found.width));
              setHeight(String(found.height));
            }
          }}
        />
        <div className="whiteboard-canvas-dimensions-row">
          <label>
            <span className="form-label">{t('whiteboard.canvasWidth')}</span>
            <input
              autoComplete="off"
              type="number"
              min={64}
              max={4096}
              className="text-input"
              value={width}
              onChange={e => { setWidth(e.target.value); setPreset('custom'); }}
            />
          </label>
          <label>
            <span className="form-label">{t('whiteboard.canvasHeight')}</span>
            <input
              autoComplete="off"
              type="number"
              min={64}
              max={4096}
              className="text-input"
              value={height}
              onChange={e => { setHeight(e.target.value); setPreset('custom'); }}
            />
          </label>
        </div>
        <label className="form-label">{t('whiteboard.canvasBackground')}</label>
        <input
          autoComplete="off"
          type="text"
          maxLength={7}
          className="text-input"
          value={bgColor}
          onChange={e => setBgColor(e.target.value)}
        />
        <label className="settings-switch-row">
          <span className="settings-switch-title">{t('whiteboard.transparentCanvas')}</span>
          <span className="modern-switch">
            <input
              autoComplete="off"
              type="checkbox"
              checked={transparent}
              onChange={e => setTransparent(e.target.checked)}
            />
            <span className="switch-slider" />
          </span>
        </label>
      </div>
    </ModalDialog>
  );
}
