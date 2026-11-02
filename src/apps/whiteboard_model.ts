import * as Y from 'yjs';
import { PROFILE_CHUNK, PROFILE_MAX_BYTES } from '../core/profile_image.ts';
import { decodeUpdate, encodeUpdate, type RoomAppModel, type RoomAppModelContext } from './models.ts';
import { inspectPngBytes, verifyWhiteboardPng, type WhiteboardImageRecord } from './whiteboard_image.ts';
import { flipBoardLayer, scaleBoardLayer, type BoardBox } from './whiteboard_interaction.ts';
import { WhiteboardRasterEngine } from './whiteboard_raster.ts';
import {
  boardCoordinate, boardId, BOARD_MAX_POINTS, BOARD_MAX_SHAPES, DEFAULT_BOARD_LAYER,
  defaultBoardCanvasSettings, defaultBoardLayer, parseBoardFile, validBoardCanvasSettings,
  validBoardHash, validBoardLayer, validBoardShape,
  type BoardCanvasSettings, type BoardLayer, type BoardPoint, type BoardShape, type BoardTool,
} from './whiteboard_scene.ts';

export interface BoardCursor extends BoardPoint {
  tool: BoardTool | 'hand' | 'move';
  width: number;
  color: string;
  draft?: BoardShape;
  seenAt: number;
}
interface PendingImage {
  hash: string;
  peer: string;
  token: string;
  parts: string[];
  length: number;
  size: number;
  until: number;
  validating: boolean;
}
const LOCAL = 'board-local';
const MAX_UPDATE = 3_000_000;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const CURSOR_TOOLS = [
  'pointer', 'hand', 'move', 'brush', 'eraser', 'bucket', 'gradient', 'eyedropper',
  'selectRect', 'selectEllipse', 'lasso', 'wand', 'rectangle', 'ellipse', 'line', 'text',
];

function validCanvasMeta(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 240) return false;
  try {
    return validBoardCanvasSettings(JSON.parse(value));
  } catch {
    return false;
  }
}

export class WhiteboardModel implements RoomAppModel {
  readonly document = new Y.Doc();
  private objects = this.document.getMap<BoardShape>('shapes');
  private fallbackLayer = defaultBoardLayer();
  private layerMap = this.document.getMap<BoardLayer>('layers');
  private metadata = this.document.getMap<string>('file');
  readonly history = new Y.UndoManager([this.objects, this.layerMap], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
  readonly cursors = new Map<string, BoardCursor>();
  readonly images = new Map<string, string>();
  readonly raster = new WhiteboardRasterEngine();
  private imageSizes = new Map<string, number>();
  private imageSources = new Map<string, string>();
  private pendingImages = new Map<string, PendingImage>();
  private imageAttempts = new Map<string, number>();
  private lastImageSend = new Map<string, number>();
  private sendingPeers = new Set<string>();
  private queuedRequests = new Map<string, { hash: string; token: string; actor: string }>();
  private participants = new Set<string>();
  private destroyed = false;
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
      for (const [actor, cursor] of this.cursors) {
        if (Date.now() - cursor.seenAt > 3000) { this.cursors.delete(actor); changed = true; }
      }
      for (const [hash, pending] of this.pendingImages) {
        if (pending.until < Date.now() && !pending.validating) this.pendingImages.delete(hash);
      }
      if (this.pendingImages.size < 4) this.requestWaitingImages();
      if (changed) context.changed();
    }, 1000);
    (this.expiry as unknown as { unref?: () => void }).unref?.();
  }

  get shapes(): BoardShape[] {
    return [...this.objects.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }
  get layers(): BoardLayer[] {
    const layers = [...this.layerMap.values()].filter(l => !l.deleted);
    if (!this.layerMap.size) layers.push(this.fallbackLayer);
    return layers.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }
  get canvasSettings(): BoardCanvasSettings {
    const raw = this.metadata.get('canvas');
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (validBoardCanvasSettings(parsed)) return parsed;
      } catch { /* fallback */ }
    }
    return defaultBoardCanvasSettings();
  }
  get identity(): { id: string; name: string } | null {
    const id = this.metadata.get('id'), name = this.metadata.get('name');
    return boardId(id) && name ? { id, name } : null;
  }
  get content(): string {
    const activeShapes = this.shapes.filter(s => this.layers.some(l => l.id === (s.layerId ?? DEFAULT_BOARD_LAYER)));
    const usedImages: Record<string, string> = {};
    for (const s of activeShapes) {
      if (s.tool === 'image' && s.imageHash && this.images.has(s.imageHash)) {
        usedImages[s.imageHash] = this.images.get(s.imageHash)!;
      }
    }
    const rawCanvas = this.metadata.get('canvas');
    return JSON.stringify({
      version: 2,
      shapes: activeShapes,
      layers: this.layers,
      ...(Object.keys(usedImages).length ? { images: usedImages } : {}),
      ...(rawCanvas ? { canvas: this.canvasSettings } : {}),
    });
  }

  getLayerPixels(layerId: string, drafts?: readonly BoardShape[]): Uint8ClampedArray {
    const layer = this.layers.find(l => l.id === layerId) ?? this.layers[0] ?? this.fallbackLayer;
    const { width, height } = this.canvasSettings;
    return this.raster.getLayerBuffer(layer, this.shapes, width, height, this.layers, drafts);
  }

  getCompositePixels(draftsByLayer?: ReadonlyMap<string, BoardShape[]>, includeBackground = true): Uint8ClampedArray {
    const { width, height, backgroundColor, transparent } = this.canvasSettings;
    return this.raster.getCompositeBuffer(
      this.layers,
      this.shapes,
      width,
      height,
      includeBackground && !transparent ? backgroundColor : null,
      draftsByLayer,
    );
  }

  sampleColor(x: number, y: number, sampleAll = true, activeLayerId = DEFAULT_BOARD_LAYER): string {
    const { width, height, backgroundColor } = this.canvasSettings;
    return this.raster.samplePixelHex(
      this.layers,
      this.shapes,
      width,
      height,
      x,
      y,
      sampleAll,
      activeLayerId,
      backgroundColor,
    );
  }

  imageUrl(hash: string): string | undefined {
    const data = this.images.get(hash);
    return data ? `data:image/png;base64,${data}` : undefined;
  }

  cacheImage(hash: string, data: string): void {
    const clean = data.startsWith('data:image/png;base64,') ? data.slice(22) : data;
    if (!validBoardHash(hash) || !clean || clean.length > Math.ceil(PROFILE_MAX_BYTES / 3) * 4) return;
    this.images.delete(hash);
    this.imageSizes.delete(hash);
    while (this.images.size && [...this.imageSizes.values()].reduce((sum, n) => sum + n, 0) + clean.length > MAX_CACHE_BYTES) {
      const oldest = this.images.keys().next().value!;
      this.images.delete(oldest);
      this.imageSizes.delete(oldest);
    }
    this.images.set(hash, clean);
    this.imageSizes.set(hash, clean.length);
  }

  setIdentity(id: string, name: string): void {
    if (!boardId(id) || !name.trim() || name.length > 80) throw new Error('whiteboard.invalidFile');
    this.document.transact(() => { this.metadata.set('id', id); this.metadata.set('name', name.trim()); }, LOCAL);
  }

  setCanvasSettings(settings: BoardCanvasSettings): void {
    if (!validBoardCanvasSettings(settings)) throw new Error('whiteboard.invalidFile');
    this.transact(doc => {
      doc.getMap('file').set('canvas', JSON.stringify(settings));
    });
  }

  private validDocument(doc: Y.Doc): boolean {
    const shapes = doc.getMap<BoardShape>('shapes'), meta = doc.getMap('file');
    return [...doc.share.keys()].every(key => key === 'shapes' || key === 'file' || key === 'layers') &&
      doc.getMap('layers').size <= 128 && [...doc.getMap('layers')].every(([id, layer]) => validBoardLayer(layer) && layer.id === id) &&
      [...doc.getMap<BoardLayer>('layers').values()].filter(l => !l.deleted).length <= 64 &&
      shapes.size <= BOARD_MAX_SHAPES && [...shapes].every(([id, shape]) => validBoardShape(shape) && id === shape.id) &&
      JSON.stringify({ version: 2, shapes: [...shapes.values()], layers: [...doc.getMap('layers').values()] }).length <= 4_000_000 &&
      meta.size <= 3 && [...meta].every(([key, value]) =>
        key === 'id' ? boardId(value) :
        key === 'name' ? typeof value === 'string' && value.trim().length > 0 && value.length <= 80 :
        key === 'canvas' && validCanvasMeta(value)) &&
      Y.encodeStateAsUpdate(doc).byteLength <= MAX_UPDATE;
  }

  private transact(action: (doc: Y.Doc) => void): void {
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.document));
      candidate.transact(() => action(candidate), LOCAL);
      if (!this.validDocument(candidate)) throw new Error('whiteboard.limit');
      Y.applyUpdate(this.document, Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(this.document)), LOCAL);
    } finally { candidate.destroy(); }
  }

  put(shape: BoardShape): void {
    const layerId = shape.layerId ?? DEFAULT_BOARD_LAYER;
    const layer = this.layers.find(l => l.id === layerId);
    if (!layer || layer.locked || layer.hidden) return;
    const segments: BoardShape[] = [];
    if ((shape.tool === 'brush' || shape.tool === 'eraser') && shape.points.length > BOARD_MAX_POINTS) {
      const groupId = shape.groupId ?? crypto.randomUUID();
      const step = BOARD_MAX_POINTS - 1;
      let order = shape.order;
      for (let offset = 0; offset < shape.points.length; offset += step) {
        const slice = shape.points.slice(offset, offset + BOARD_MAX_POINTS);
        if (slice.length < 2 && offset > 0) break;
        segments.push({
          ...shape,
          id: offset === 0 ? shape.id : crypto.randomUUID(),
          groupId,
          order: order++,
          points: slice,
        });
        if (offset + BOARD_MAX_POINTS >= shape.points.length) break;
      }
    } else {
      segments.push(shape);
    }
    this.transact(doc => {
      if (!doc.getMap('layers').size) doc.getMap('layers').set(DEFAULT_BOARD_LAYER, defaultBoardLayer());
      const shapesMap = doc.getMap('shapes');
      for (const item of segments) shapesMap.set(item.id, item);
    });
  }

  pasteImage(image: WhiteboardImageRecord, box: BoardBox, layerId: string, newLayerName?: string): string {
    if (!validBoardHash(image.hash) || !image.data) throw new Error('Invalid image');
    const raw = image.data.startsWith('data:image/png;base64,') ? image.data.slice(22) : image.data;
    inspectPngBytes(Uint8Array.from(atob(raw), c => c.charCodeAt(0)));
    this.cacheImage(image.hash, raw);
    const maxLayerOrder = Math.max(0, ...this.layers.map(l => l.order));
    const maxShapeOrder = this.shapes[this.shapes.length - 1]?.order ?? 0;
    const existingLayer = !newLayerName ? this.layers.find(l => l.id === layerId) : undefined;
    if (!newLayerName && (!existingLayer || existingLayer.locked || existingLayer.hidden)) return layerId;
    const lx = existingLayer?.x ?? 0, ly = existingLayer?.y ?? 0;
    const shape: BoardShape = {
      id: crypto.randomUUID(),
      layerId,
      tool: 'image',
      imageHash: image.hash,
      points: [
        { x: Math.round((box.x - lx) * 100) / 100, y: Math.round((box.y - ly) * 100) / 100 },
        { x: Math.round((box.x - lx + box.width) * 100) / 100, y: Math.round((box.y - ly + box.height) * 100) / 100 },
      ],
      color: '#000000',
      width: 1,
      filled: false,
      x: 0,
      y: 0,
      order: maxShapeOrder + 1,
      hidden: false,
      locked: false,
    };
    this.transact(doc => {
      const layers = doc.getMap('layers');
      if (!layers.size) layers.set(DEFAULT_BOARD_LAYER, defaultBoardLayer());
      if (newLayerName) {
        layers.set(layerId, { ...defaultBoardLayer(), id: layerId, name: newLayerName.trim(), order: maxLayerOrder + 1 });
      }
      doc.getMap('shapes').set(shape.id, shape);
    });
    if (this.context.localView) {
      this.context.emit({ localImage: { hash: image.hash, data: raw } });
    }
    return layerId;
  }

  resizeLayer(id: string, from: BoardBox, to: BoardBox): void {
    const layer = this.layers.find(l => l.id === id);
    if (!layer || layer.locked || layer.hidden) return;
    const { layer: nextLayer, shapes: nextShapes } = scaleBoardLayer(layer, this.shapes, from, to);
    this.transact(doc => {
      const layers = doc.getMap('layers');
      if (!layers.size) layers.set(DEFAULT_BOARD_LAYER, defaultBoardLayer());
      layers.set(nextLayer.id, nextLayer);
      const shapesMap = doc.getMap('shapes');
      for (const s of nextShapes) shapesMap.set(s.id, s);
    });
  }

  flipLayer(id: string, axis: 'x' | 'y'): void {
    const layer = this.layers.find(l => l.id === id);
    if (!layer || layer.locked || layer.hidden) return;
    const { width, height } = this.canvasSettings;
    const { layer: nextLayer, shapes: nextShapes } = flipBoardLayer(layer, this.shapes, axis, width, height);
    this.transact(doc => {
      const layers = doc.getMap('layers');
      if (!layers.size) layers.set(DEFAULT_BOARD_LAYER, defaultBoardLayer());
      layers.set(nextLayer.id, nextLayer);
      const shapesMap = doc.getMap('shapes');
      for (const s of nextShapes) shapesMap.set(s.id, s);
    });
  }

  clearLayer(id: string, clipPolygon?: BoardPoint[]): void {
    const layer = this.layers.find(l => l.id === id);
    if (!layer || layer.locked || layer.hidden) return;
    const maxOrder = this.shapes[this.shapes.length - 1]?.order ?? 0;
    const localPolygon = clipPolygon?.map(p => ({
      x: Math.round((p.x - layer.x) * 100) / 100,
      y: Math.round((p.y - layer.y) * 100) / 100,
    }));
    const clearShape: BoardShape = {
      id: crypto.randomUUID(),
      layerId: id,
      tool: 'clear',
      points: [{ x: 0, y: 0 }],
      color: '#000000',
      width: 1,
      filled: true,
      x: 0,
      y: 0,
      order: maxOrder + 1,
      hidden: false,
      locked: false,
      ...(localPolygon?.length ? { clipPolygon: localPolygon } : {}),
    };
    this.put(clearShape);
  }

  duplicateLayer(id: string, name: string): string {
    const source = this.layers.find(l => l.id === id);
    if (!source || this.layers.length >= 64) throw new Error('whiteboard.limit');
    const newId = crypto.randomUUID();
    const sourceShapes = this.shapes.filter(s => (s.layerId ?? DEFAULT_BOARD_LAYER) === id);
    let nextOrder = (this.shapes[this.shapes.length - 1]?.order ?? 0) + 1;
    const groupMap = new Map<string, string>();
    const clonedShapes = sourceShapes.map(s => {
      let groupId = s.groupId;
      if (groupId) {
        if (!groupMap.has(groupId)) groupMap.set(groupId, crypto.randomUUID());
        groupId = groupMap.get(groupId);
      }
      return {
        ...s,
        id: crypto.randomUUID(),
        layerId: newId,
        order: nextOrder++,
        ...(groupId ? { groupId } : {}),
      };
    });
    const layers = this.layers;
    const sourceIdx = layers.findIndex(l => l.id === id);
    const updatedOrders = new Map<string, number>();
    let orderCounter = 0;
    for (let i = 0; i < layers.length; i++) {
      updatedOrders.set(layers[i].id, orderCounter++);
      if (i === sourceIdx) orderCounter++;
    }
    const newLayerOrder = (updatedOrders.get(id) ?? 0) + 1;

    this.transact(doc => {
      const layerMap = doc.getMap<BoardLayer>('layers');
      if (!layerMap.size) layerMap.set(DEFAULT_BOARD_LAYER, defaultBoardLayer());
      for (const l of layers) {
        layerMap.set(l.id, { ...l, order: updatedOrders.get(l.id) ?? l.order });
      }
      layerMap.set(newId, {
        ...source,
        id: newId,
        name: name.trim().slice(0, 80),
        order: newLayerOrder,
        locked: false,
      });
      const shapesMap = doc.getMap<BoardShape>('shapes');
      for (const cs of clonedShapes) shapesMap.set(cs.id, cs);
    });
    return newId;
  }

  mergeLayerDown(id: string): string | null {
    const layers = this.layers;
    const idx = layers.findIndex(l => l.id === id);
    if (idx <= 0) return null;
    const upper = layers[idx];
    const lower = layers[idx - 1];
    if (upper.locked || lower.locked || upper.hidden || lower.hidden) return null;
    const dx = upper.x - lower.x;
    const dy = upper.y - lower.y;
    const upperOpacityFactor = (upper.opacity ?? 100) / 100;
    const upperShapes = this.shapes.filter(s => (s.layerId ?? DEFAULT_BOARD_LAYER) === upper.id);
    let nextOrder = (this.shapes[this.shapes.length - 1]?.order ?? 0) + 1;

    this.transact(doc => {
      const layerMap = doc.getMap<BoardLayer>('layers');
      if (!layerMap.size) layerMap.set(DEFAULT_BOARD_LAYER, defaultBoardLayer());
      layerMap.set(upper.id, { ...upper, deleted: true });
      const shapesMap = doc.getMap<BoardShape>('shapes');
      for (const s of upperShapes) {
        const mergedOpacity = Math.max(1, Math.min(100, Math.round((s.opacity ?? 100) * upperOpacityFactor)));
        shapesMap.set(s.id, {
          ...s,
          layerId: lower.id,
          x: Math.round((s.x + dx) * 100) / 100,
          y: Math.round((s.y + dy) * 100) / 100,
          opacity: mergedOpacity,
          order: nextOrder++,
        });
      }
    });
    return lower.id;
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
  updateLayer(layer: BoardLayer): void {
    this.transact(doc => {
      const layers = doc.getMap('layers');
      if (!layers.size) layers.set(DEFAULT_BOARD_LAYER, defaultBoardLayer());
      layers.set(layer.id, layer);
    });
  }
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
    if (file.images) {
      for (const [hash, data] of Object.entries(file.images)) {
        try {
          inspectPngBytes(Uint8Array.from(atob(data), c => c.charCodeAt(0)));
        } catch {
          throw new Error('whiteboard.invalidFile');
        }
        void verifyWhiteboardPng(data, hash).then(valid => {
          this.cacheImage(hash, valid.data);
          this.context.changed();
        }).catch(() => {});
      }
    }
    this.transact(doc => {
      const shapes = doc.getMap('shapes'); shapes.clear();
      const layers = doc.getMap('layers'); layers.clear();
      for (const layer of file.layers ?? [defaultBoardLayer()]) layers.set(layer.id, layer);
      for (const shape of file.shapes) shapes.set(shape.id, shape);
      const meta = doc.getMap('file');
      meta.set('id', id); meta.set('name', name);
      if (file.canvas) meta.set('canvas', JSON.stringify(file.canvas));
      else meta.delete('canvas');
    });
    this.raster.clear();
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
    for (const [hash, pending] of this.pendingImages) {
      if (pending.peer && !this.participants.has(pending.peer) && !pending.validating) this.pendingImages.delete(hash);
    }
    this.requestWaitingImages();
  }
  snapshot(): unknown { return { update: encodeUpdate(Y.encodeStateAsUpdate(this.document)) }; }
  localSnapshot(): unknown { return { ...this.snapshot() as object, cursors: [...this.cursors], images: [...this.images] }; }
  applyLocalSnapshot(value: unknown): void {
    const images = (value as { images?: [string, string][] })?.images;
    if (Array.isArray(images)) {
      for (const [hash, data] of images) if (validBoardHash(hash) && typeof data === 'string') this.cacheImage(hash, data);
    }
    this.apply(value, this.context.localActor, true);
    const cursors = (value as { cursors?: [string, BoardCursor][] })?.cursors;
    if (Array.isArray(cursors)) {
      this.cursors.clear();
      for (const [actor, cursor] of cursors) if (actor !== this.context.localActor) this.acceptCursor(cursor, actor);
    }
  }

  private sendToPeer(payload: unknown, peerId: string): void {
    if (this.context.send && peerId && peerId !== this.context.localActor && this.participants.has(peerId)) {
      void this.context.send(payload, peerId).catch(() => {});
    } else {
      this.context.emit(payload);
    }
  }

  private requestWaitingImages(preferredActor?: string): void {
    if (this.destroyed || this.context.localView) return;
    const needed = new Set<string>();
    for (const s of this.shapes) {
      if (s.tool === 'image' && s.imageHash && !this.images.has(s.imageHash)) {
        needed.add(s.imageHash);
        if (preferredActor && preferredActor !== this.context.localActor) {
          this.imageSources.set(s.imageHash, preferredActor);
        }
      }
    }
    for (const hash of needed) {
      if (this.pendingImages.has(hash) || this.pendingImages.size >= 4) continue;
      const peer = this.imageSources.get(hash) ?? [...this.participants].find(p => p !== this.context.localActor) ?? '';
      const attemptKey = `${peer}:${hash}`;
      const count = this.imageAttempts.get(attemptKey) ?? 0;
      if (count >= 2) continue;
      this.imageAttempts.set(attemptKey, count + 1);
      const token = crypto.randomUUID();
      this.pendingImages.set(hash, { hash, peer, token, parts: [], length: 0, size: 0, until: Date.now() + 60_000, validating: false });
      this.sendToPeer({ imageRequest: { hash, token } }, peer);
    }
  }

  private handleImageRequest(req: unknown, actor: string): void {
    if (this.destroyed || !req || typeof req !== 'object') return;
    if (this.participants.size > 0 && !this.participants.has(actor) && actor !== this.context.localActor) return;
    const { hash, token } = req as { hash?: unknown; token?: unknown };
    if (!validBoardHash(hash) || !boardId(token)) return;
    const data = this.images.get(hash);
    if (!data) return;
    if (this.sendingPeers.has(actor)) {
      this.queuedRequests.set(actor, { hash, token, actor });
      return;
    }
    const sendKey = `${actor}:${hash}`;
    const lastAt = this.lastImageSend.get(sendKey) ?? 0;
    if (Date.now() - lastAt < 3000) return;
    this.lastImageSend.set(sendKey, Date.now());
    this.sendingPeers.add(actor);
    void (async () => {
      try {
        for (let offset = 0; offset < data.length; offset += PROFILE_CHUNK) {
          if (this.destroyed || (this.participants.size > 0 && !this.participants.has(actor) && actor !== this.context.localActor)) break;
          this.sendToPeer({
            imageChunk: {
              hash,
              token,
              size: data.length,
              index: offset / PROFILE_CHUNK,
              data: data.slice(offset, offset + PROFILE_CHUNK),
            },
          }, actor);
          await Promise.resolve();
        }
      } finally {
        this.sendingPeers.delete(actor);
        const next = this.queuedRequests.get(actor);
        this.queuedRequests.delete(actor);
        if (next) this.handleImageRequest(next, next.actor);
      }
    })();
  }

  private handleImageChunk(chunk: unknown, actor: string): void {
    if (this.destroyed || !chunk || typeof chunk !== 'object') return;
    const c = chunk as { hash?: unknown; token?: unknown; size?: unknown; index?: unknown; data?: unknown };
    if (!validBoardHash(c.hash) || !boardId(c.token)) return;
    const pending = this.pendingImages.get(c.hash);
    if (!pending || pending.validating || pending.until < Date.now() || pending.token !== c.token ||
      (pending.peer && pending.peer !== actor)) return;
    const size = c.size as number;
    if (!Number.isInteger(size) || size <= 0 || size > Math.ceil(PROFILE_MAX_BYTES / 3) * 4 ||
      (pending.size !== 0 && pending.size !== size)) return;
    if (c.index !== pending.parts.length || typeof c.data !== 'string' ||
      c.data.length !== Math.min(PROFILE_CHUNK, size - pending.length) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(c.data)) return;
    pending.size = size;
    pending.parts.push(c.data);
    pending.length += c.data.length;
    if (pending.length === size) {
      pending.validating = true;
      const assembled = pending.parts.join('');
      const targetHash = pending.hash;
      void verifyWhiteboardPng(assembled, targetHash)
        .then(verified => {
          if (this.destroyed) return;
          this.cacheImage(targetHash, verified.data);
          this.context.changed();
        })
        .catch(() => { /* Invalid or tampered images never reach the board. */ })
        .finally(() => {
          if (this.pendingImages.get(targetHash) === pending) this.pendingImages.delete(targetHash);
          this.requestWaitingImages();
        });
    }
  }

  private acceptCursor(value: unknown, actor: string): void {
    if (value === null) { if (this.cursors.delete(actor)) this.context.changed(); return; }
    const c = value as BoardCursor;
    if (!c || !boardCoordinate(c.x) || !boardCoordinate(c.y) || !CURSOR_TOOLS.includes(c.tool) ||
      !Number.isFinite(c.width) || c.width < 1 || c.width > 2000 || typeof c.color !== 'string' || !/^#[\da-f]{6}$/i.test(c.color) ||
      (c.draft !== undefined && !validBoardShape(c.draft))) return;
    const previous = this.cursors.get(actor);
    if (previous && Date.now() - previous.seenAt < 25) return;
    this.cursors.set(actor, { ...c, seenAt: Date.now() }); this.context.changed();
  }

  apply(payload: unknown, actor: string, fromSnapshot: boolean): void {
    if (!payload || typeof payload !== 'object') return;
    const value = payload as {
      update?: unknown;
      cursor?: unknown;
      imageRequest?: unknown;
      imageChunk?: unknown;
      localImage?: { hash?: unknown; data?: unknown };
    };
    if (!fromSnapshot && value.localImage && actor === this.context.localActor) {
      const { hash, data } = value.localImage;
      if (validBoardHash(hash) && typeof data === 'string') {
        this.cacheImage(hash, data);
        this.context.changed();
      }
      return;
    }
    if (!fromSnapshot && 'imageRequest' in value) {
      this.handleImageRequest(value.imageRequest, actor);
      return;
    }
    if (!fromSnapshot && 'imageChunk' in value) {
      this.handleImageChunk(value.imageChunk, actor);
      return;
    }
    if (!fromSnapshot && 'cursor' in value) {
      if (this.participants.has(actor) || actor === this.context.localActor) this.acceptCursor(value.cursor, actor);
      return;
    }
    const update = decodeUpdate(value.update, MAX_UPDATE);
    if (!update || update.byteLength > MAX_UPDATE) return;
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.document));
      Y.applyUpdate(candidate, update);
      if (this.validDocument(candidate)) {
        Y.applyUpdate(this.document, update, 'remote');
        this.requestWaitingImages(actor);
      }
    } catch { /* Malformed packets must not mutate the live scene. */ }
    finally { candidate.destroy(); }
  }

  destroy(): void {
    this.destroyed = true;
    clearInterval(this.expiry);
    this.pendingImages.clear();
    this.queuedRequests.clear();
    this.raster.clear();
    this.history.destroy();
    this.document.destroy();
    this.cursors.clear();
  }
}
