import * as Y from 'yjs';
import { decodeUpdate, encodeUpdate, type RoomAppModel, type RoomAppModelContext } from './models.ts';
import { boardCoordinate, boardId, BOARD_MAX_SHAPES, DEFAULT_BOARD_LAYER, defaultBoardLayer, validBoardLayer, parseBoardFile, validBoardShape, type BoardLayer, type BoardPoint, type BoardShape, type BoardTool } from './whiteboard_scene.ts';

export interface BoardCursor extends BoardPoint { tool: BoardTool | 'hand' | 'move'; width: number; color: string; draft?: BoardShape; seenAt: number }
const LOCAL = 'board-local';
const MAX_UPDATE = 700_000;
export class WhiteboardModel implements RoomAppModel {
  readonly document = new Y.Doc();
  private objects = this.document.getMap<BoardShape>('shapes');
  private fallbackLayer = defaultBoardLayer();
  private layerMap = this.document.getMap<BoardLayer>('layers');
  private metadata = this.document.getMap<string>('file');
  readonly history = new Y.UndoManager([this.objects, this.layerMap], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
  readonly cursors = new Map<string, BoardCursor>();
  private participants = new Set<string>();
  private expiry: ReturnType<typeof setInterval>;
  private context: RoomAppModelContext;
  constructor(context: RoomAppModelContext) {
    this.context = context;
    this.document.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') context.emit({ update: encodeUpdate(update) });
      context.changed();
    });
    this.expiry = setInterval(() => {
      let changed = false;
      for (const [actor, cursor] of this.cursors) if (Date.now() - cursor.seenAt > 3000) { this.cursors.delete(actor); changed = true; }
      if (changed) context.changed();
    }, 1000);
  }
  get shapes(): BoardShape[] { return [...this.objects.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)); }
  get layers(): BoardLayer[] {
    const layers = [...this.layerMap.values()].filter(l => !l.deleted);
    if (!this.layerMap.size) layers.push(this.fallbackLayer);
    return layers.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }
  get identity(): { id: string; name: string } | null {
    const id = this.metadata.get('id'), name = this.metadata.get('name');
    return boardId(id) && name ? { id, name } : null;
  }
  get content(): string { return JSON.stringify({ version: 2, shapes: this.shapes.filter(s => this.layers.some(l => l.id === (s.layerId ?? DEFAULT_BOARD_LAYER))), layers: this.layers }); }
  setIdentity(id: string, name: string): void {
    if (!boardId(id) || !name.trim() || name.length > 80) throw new Error('whiteboard.invalidFile');
    this.document.transact(() => { this.metadata.set('id', id); this.metadata.set('name', name.trim()); }, LOCAL);
  }
  private validDocument(doc: Y.Doc): boolean {
    const shapes = doc.getMap<BoardShape>('shapes'), meta = doc.getMap('file');
    return [...doc.share.keys()].every(key => key === 'shapes' || key === 'file' || key === 'layers') &&
      doc.getMap('layers').size <= 128 && [...doc.getMap('layers')].every(([id, layer]) => validBoardLayer(layer) && layer.id === id) &&
      [...doc.getMap<BoardLayer>('layers').values()].filter(l => !l.deleted).length <= 64 &&
      shapes.size <= BOARD_MAX_SHAPES && [...shapes].every(([id, shape]) => validBoardShape(shape) && id === shape.id) &&
      JSON.stringify({ version: 2, shapes: [...shapes.values()], layers: [...doc.getMap('layers').values()] }).length <= 400_000 && meta.size <= 2 && [...meta].every(([key, value]) =>
        key === 'id' ? boardId(value) : key === 'name' && typeof value === 'string' && value.trim().length > 0 && value.length <= 80) &&
      Y.encodeStateAsUpdate(doc).byteLength <= MAX_UPDATE;
  }
  private transact(action: (doc: Y.Doc) => void): void {
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.document));
      candidate.transact(() => action(candidate), LOCAL);
      if (!this.validDocument(candidate)) throw new Error('whiteboard.limit');
      // Apply the validated changes as one undoable, convergent transaction.
      Y.applyUpdate(this.document, Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(this.document)), LOCAL);
    } finally { candidate.destroy(); }
  }
  put(shape: BoardShape): void {
    const layerId = shape.layerId ?? DEFAULT_BOARD_LAYER;
    const layer = this.layers.find(l => l.id === layerId);
    if (!layer || layer.locked || layer.hidden) return;
    this.transact(doc => {
      if (!doc.getMap('layers').size) doc.getMap('layers').set(DEFAULT_BOARD_LAYER, defaultBoardLayer());
      doc.getMap('shapes').set(shape.id, shape);
    });
  }
  addLayer(name: string): string {
    const id = crypto.randomUUID();
    this.transact(doc => {
      const layers = doc.getMap('layers');
      if (!layers.size) layers.set(DEFAULT_BOARD_LAYER, defaultBoardLayer());
      layers.set(id, { ...defaultBoardLayer(), id, name: name.trim(), order: Math.max(...this.layers.map(l => l.order)) + 1 });
    });
    return id;
  }
  updateLayer(layer: BoardLayer): void { this.transact(doc => doc.getMap('layers').set(layer.id, layer)); }
  removeLayer(id: string): void {
    const layer = this.layers.find(l => l.id === id);
    if (!layer || layer.locked || this.layers.length <= 1) return;
    this.transact(doc => {
      doc.getMap('layers').set(id, { ...layer, deleted: true });
      const shapes = doc.getMap<BoardShape>('shapes');
      for (const [key, shape] of shapes) if ((shape.layerId ?? DEFAULT_BOARD_LAYER) === id) shapes.delete(key);
    });
  }
  reorderLayers(ids: string[]): void {
    const layers = this.layers;
    if (ids.length !== layers.length || new Set(ids).size !== layers.length || ids.some(id => !layers.some(l => l.id === id))) return;
    this.transact(doc => { ids.forEach((id, order) => doc.getMap('layers').set(id, { ...layers.find(l => l.id === id)!, order })); });
  }
  remove(id: string): void { this.transact(doc => doc.getMap('shapes').delete(id)); }
  replace(content: string, id: string, name: string): void {
    const file = parseBoardFile(content);
    if (!boardId(id) || !name.trim() || name.length > 80) throw new Error('whiteboard.invalidFile');
    this.transact(doc => {
      const shapes = doc.getMap('shapes'); shapes.clear();
      const layers = doc.getMap('layers'); layers.clear();
      for (const layer of file.layers ?? [defaultBoardLayer()]) layers.set(layer.id, layer);
      for (const shape of file.shapes) shapes.set(shape.id, shape);
      doc.getMap('file').set('id', id); doc.getMap('file').set('name', name);
    });
    this.history.clear();
  }
  undo(): void { this.history.undo(); this.context.changed(); }
  redo(): void { this.history.redo(); this.context.changed(); }
  presence(cursor: Omit<BoardCursor, 'seenAt'> | null): void {
    this.context.emit({ cursor });
  }
  setParticipants(participants: string[]): void {
    this.participants = new Set(participants);
    for (const actor of this.cursors.keys()) if (!this.participants.has(actor)) this.cursors.delete(actor);
  }
  snapshot(): unknown { return { update: encodeUpdate(Y.encodeStateAsUpdate(this.document)) }; }
  localSnapshot(): unknown { return { ...this.snapshot() as object, cursors: [...this.cursors] }; }
  applyLocalSnapshot(value: unknown): void {
    this.apply(value, this.context.localActor, true);
    const cursors = (value as { cursors?: [string, BoardCursor][] })?.cursors;
    if (Array.isArray(cursors)) {
      this.cursors.clear();
      for (const [actor, cursor] of cursors) if (actor !== this.context.localActor) this.acceptCursor(cursor, actor);
    }
  }
  private acceptCursor(value: unknown, actor: string): void {
    if (value === null) { if (this.cursors.delete(actor)) this.context.changed(); return; }
    const c = value as BoardCursor;
    if (!c || !boardCoordinate(c.x) || !boardCoordinate(c.y) || !['pointer', 'hand', 'move', 'brush', 'eraser', 'rectangle', 'ellipse', 'line'].includes(c.tool) ||
      !Number.isFinite(c.width) || c.width < 1 || c.width > 2000 || typeof c.color !== 'string' || !/^#[\da-f]{6}$/i.test(c.color) ||
      (c.draft !== undefined && !validBoardShape(c.draft))) return;
    const previous = this.cursors.get(actor);
    if (previous && Date.now() - previous.seenAt < 25) return;
    this.cursors.set(actor, { ...c, seenAt: Date.now() }); this.context.changed();
  }
  apply(payload: unknown, actor: string, fromSnapshot: boolean): void {
    if (!payload || typeof payload !== 'object') return;
    const value = payload as { update?: unknown; cursor?: unknown };
    if (!fromSnapshot && 'cursor' in value) {
      if (this.participants.has(actor) || actor === this.context.localActor) this.acceptCursor(value.cursor, actor);
      return;
    }
    const update = decodeUpdate(value.update);
    if (!update || update.byteLength > MAX_UPDATE) return;
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.document));
      Y.applyUpdate(candidate, update);
      if (this.validDocument(candidate)) Y.applyUpdate(this.document, update, 'remote');
    } catch { /* Malformed packets must not mutate the live scene. */ }
    finally { candidate.destroy(); }
  }
  destroy(): void { clearInterval(this.expiry); this.history.destroy(); this.document.destroy(); this.cursors.clear(); }
}
