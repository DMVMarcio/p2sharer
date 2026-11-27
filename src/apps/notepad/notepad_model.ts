import { t } from '../../i18n/index.ts';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as decoding from 'lib0/decoding';
import { validProfileHash } from '../../core/profile_image.ts';
import {
  decodeBase64, inspectPngBytes, PeerImageStore, stripDataPrefix, type WhiteboardImageRecord,
} from '../shared/whiteboard_image.ts';
import { decodeUpdate, encodeUpdate, MAX_UPDATE, type RoomAppModel, type RoomAppModelContext } from '../models.ts';

const MAX_NOTE = 500_000;

function collectXmlImageHashes(fragment: Y.XmlFragment | Y.XmlElement, out: Set<string>): void {
  for (const child of fragment.toArray()) {
    if (child instanceof Y.XmlElement) {
      if (child.nodeName === 'image') {
        const src = child.getAttribute('src');
        if (typeof src === 'string' && src.startsWith('p2image:')) {
          const hash = src.slice(8);
          if (validProfileHash(hash)) out.add(hash);
        }
      }
      collectXmlImageHashes(child, out);
    }
  }
}

export class NotepadModel implements RoomAppModel {
  private doc = new Y.Doc();
  private awarenessValue: Awareness | null = null;
  private awarenessClients = new Map<string, number>();
  private context: RoomAppModelContext;
  private imageStore: PeerImageStore;
  private listeners = new Set<() => void>();

  constructor(context: RoomAppModelContext) {
    this.context = context;
    this.imageStore = new PeerImageStore(
      {
        localView: context.localView,
        localActor: context.localActor,
        emit: payload => context.emit(payload),
        send: context.send ? (payload, target) => context.send!(payload, target) : undefined,
        changed: () => this.notifyChanged(),
      },
      () => {
        const hashes = new Set<string>();
        collectXmlImageHashes(this.richContent, hashes);
        return hashes;
      },
    );
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.notifyChanged();
      if (origin !== 'remote' && update.byteLength <= MAX_UPDATE)
        this.context.emit({ update: encodeUpdate(update) });
    });
  }
  private notifyChanged(): void {
    this.context.changed();
    this.listeners.forEach(fn => fn());
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  get images(): Map<string, string> { return this.imageStore.images; }
  imageUrl(hash: string): string | undefined { return this.imageStore.imageUrl(hash); }
  cacheImage(hash: string, data: string): void {
    this.imageStore.cacheImage(hash, data);
    this.notifyChanged();
  }
  registerImage(image: WhiteboardImageRecord): void {
    const clean = stripDataPrefix(image.data);
    if (!validProfileHash(image.hash) || !clean) throw new Error('Invalid image');
    inspectPngBytes(decodeBase64(clean));
    this.imageStore.cacheImage(image.hash, clean);
    if (this.context.localView) {
      this.context.emit({ localImage: { hash: image.hash, data: clean } });
    }
    this.notifyChanged();
  }
  setParticipants(participants: string[]): void {
    this.imageStore.setParticipants(participants);
  }
  get awareness(): Awareness {
    if (this.awarenessValue) return this.awarenessValue;
    const awareness = new Awareness(this.doc);
    awareness.on('update', ({ added, updated, removed }: {
      added: number[]; updated: number[]; removed: number[]
    }, origin: unknown) => {
      if (origin === 'remote') return;
      const clients = [...added, ...updated, ...removed].filter((id) => id === this.doc.clientID);
      if (clients.length) this.context.emit({ awareness: encodeUpdate(encodeAwarenessUpdate(awareness, clients)) });
    });
    this.awarenessValue = awareness;
    return awareness;
  }
  get text(): Y.Text { return this.doc.getText('content'); }
  get richContent(): Y.XmlFragment { return this.doc.getXmlFragment('rich-content'); }
  get document(): Y.Doc { return this.doc; }
  get noteIdentity(): { id: string; name: string } | null {
    const metadata = this.doc.getMap('note-file');
    const id = metadata.get('id');
    const name = metadata.get('name');
    return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      && typeof name === 'string' && name.trim().length > 0 && name.length <= 80 ? { id, name } : null;
  }
  setNoteIdentity(id: string, name: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !name.trim() || name.length > 80)
      throw new Error('Invalid note identity');
    this.doc.transact(() => {
      const metadata = this.doc.getMap('note-file');
      metadata.set('id', id.toLowerCase());
      metadata.set('name', name.trim());
    });
  }
  replace(content: string): void {
    if (content.length > MAX_NOTE) throw new Error(t("message.c915d1570950"));
    const text = this.text;
    this.doc.transact(() => { text.delete(0, text.length); text.insert(0, content); });
  }
  snapshot(): unknown { return { update: encodeUpdate(Y.encodeStateAsUpdate(this.doc)) }; }
  localSnapshot(): unknown { return { ...(this.snapshot() as object), images: [...this.images] }; }
  applyLocalSnapshot(value: unknown): void {
    const images = (value as { images?: [string, string][] })?.images;
    if (Array.isArray(images)) {
      for (const [hash, data] of images) if (validProfileHash(hash) && typeof data === 'string') this.imageStore.cacheImage(hash, data);
    }
    this.apply(value, this.context.localActor, true);
  }
  apply(payload: unknown, actor: string, fromSnapshot: boolean): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as {
      update?: unknown;
      awareness?: unknown;
      imageRequest?: unknown;
      imageChunk?: unknown;
      localImage?: { hash?: unknown; data?: unknown };
    };
    if (!fromSnapshot && data.localImage && actor === this.context.localActor) {
      const { hash, data: raw } = data.localImage;
      if (validProfileHash(hash) && typeof raw === 'string') {
        this.imageStore.cacheImage(hash, raw);
        this.notifyChanged();
      }
      return;
    }
    if (!fromSnapshot && 'imageRequest' in data) {
      this.imageStore.handleImageRequest(data.imageRequest, actor);
      return;
    }
    if (!fromSnapshot && 'imageChunk' in data) {
      this.imageStore.handleImageChunk(data.imageChunk, actor);
      return;
    }
    if (!fromSnapshot && data.awareness !== undefined) {
      const update = decodeUpdate(data.awareness);
      if (!update || update.byteLength > 4096) return;
      try {
        const decoder = decoding.createDecoder(update);
        if (decoding.readVarUint(decoder) !== 1) return;
        const clientId = decoding.readVarUint(decoder);
        if (clientId === this.doc.clientID ||
          ([...this.awarenessClients].some(([peer, id]) => peer !== actor && id === clientId))) return;
        const previous = this.awarenessClients.get(actor);
        if (previous !== undefined && previous !== clientId) return;
        this.awarenessClients.set(actor, clientId);
        if (this.awarenessValue) applyAwarenessUpdate(this.awarenessValue, update, 'remote');
      } catch { /* Reject malformed awareness data. */ }
      return;
    }
    const update = decodeUpdate(data.update);
    if (!update || this.text.length > MAX_NOTE) return;
    try {
      Y.applyUpdate(this.doc, update, 'remote');
      this.imageStore.requestWaitingImages(actor);
    } catch { /* Reject malformed updates. */ }
  }
  destroy(): void {
    this.listeners.clear();
    this.imageStore.destroy();
    this.awarenessValue?.destroy();
    this.doc.destroy();
  }
}
