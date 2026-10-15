import { useEffect, useState } from 'react';
import { useLocale } from '../hooks/useLocale';
import { useRoom } from '../hooks/useRoom';
import { showToast } from '../hooks/useToast';
import { t } from '../i18n';
import { roomAppsService } from './room_apps_service';
import type { WhiteboardModel } from './whiteboard_model';
import type { BoardShape } from './whiteboard_scene';
import { WhiteboardToolbar, type BoardSettings } from './WhiteboardToolbar';
import { WhiteboardLayers } from './WhiteboardLayers';
import { WhiteboardCanvas, type BoardViewport } from './WhiteboardCanvas';
import { boardError, useWhiteboardFiles } from './useWhiteboardFiles';

export function WhiteboardApp({ instanceId, compact = false }: { instanceId: string; compact?: boolean }) {
  useLocale();
  const { username, peers } = useRoom();
  const model = roomAppsService.getModel<WhiteboardModel>(instanceId);
  const [, refresh] = useState(0);
  const [settings, setSettings] = useState<BoardSettings>({ tool: 'pointer', color: '#3b82f6', width: 5, filled: false });
  const [layers, setLayers] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewport, setViewport] = useState<BoardViewport>({ x: 60, y: 60, zoom: 1 });
  const [resetView, setResetView] = useState(0);
  const files = useWhiteboardFiles(model, instanceId);
  useEffect(() => roomAppsService.subscribe(() => refresh(n => n + 1)), []);
  const error = (reason: unknown) => showToast(boardError(reason), 3500, 'error');
  const put = (shape: BoardShape) => { try { model?.put(shape); } catch (reason) { error(reason); } };
  const select = (id: string | null) => {
    setSelected(id);
    const shape = model?.shapes.find(s => s.id === id);
    if (shape && settings.tool === 'pointer') setSettings({ tool: 'pointer', width: shape.width, color: shape.color, filled: shape.filled });
  };
  const remove = (id: string) => { if (!model?.shapes.find(s => s.id === id)?.locked) {
    try { model?.remove(id); if (selected === id) setSelected(null); } catch (reason) { error(reason); }
  } };
  if (!model) return null;
  return <div className="whiteboard-app" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => {
      if (compact || (event.target as HTMLElement).closest('input, textarea, [contenteditable], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if (mod && key === 's') { event.preventDefault(); void files.save(); }
      else if (mod && (key === 'z' || key === 'y')) { event.preventDefault(); if (key === 'y' || event.shiftKey) model.redo(); else model.undo(); }
      else if (event.target instanceof HTMLElement && event.target.classList.contains('whiteboard-canvas')) {
        if (key === 'delete' || key === 'backspace') { event.preventDefault(); if (selected) remove(selected); }
        if (key === 'escape') setSelected(null);
        const shape = model.shapes.find(s => s.id === selected);
        if (shape && !shape.locked && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault(); const step = event.shiftKey ? 10 : 1;
          put({ ...shape, x: shape.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
            y: shape.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) });
        }
      }
    }}>
    {!compact && <><WhiteboardToolbar settings={settings} onChange={next => {
      setSettings(next);
      const shape = model.shapes.find(s => s.id === selected);
      if (settings.tool === 'pointer' && next.tool === 'pointer' && shape && !shape.locked &&
        (next.color !== settings.color || next.width !== settings.width || next.filled !== settings.filled))
        put({ ...shape, color: next.color, width: next.width, filled: next.filled });
    }} canUndo={model.history.canUndo()} canRedo={model.history.canRedo()} onUndo={() => model.undo()} onRedo={() => model.redo()}
      layers={layers} onLayers={() => setLayers(!layers)} onReset={() => setResetView(n => n + 1)} files={files.actions} />{files.status}</>}
    <div className="whiteboard-workspace">
      <WhiteboardCanvas model={model} settings={settings} viewport={viewport} onViewport={setViewport} selected={selected} onSelect={select}
        compact={compact} actor={roomAppsService.getLocalActor()} name={username} onError={error} resetView={resetView}
        participantName={actor => peers.find(peer => peer.id === actor)?.username || t('browser.participant')} />
      {!compact && layers && <WhiteboardLayers shapes={model.shapes} selected={selected} onSelect={setSelected} onChange={put} onDelete={remove} />}
    </div>
    {!compact && files.dialogs}
  </div>;
}
