import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupTestDOM } from '../helpers/browser_mocks.ts';
import { RoomService } from '../../src/services/room_service.ts';
import { GroupRoomManager } from '../../src/p2p/group_room.ts';
import { CHAT_FILE_CHUNK_BYTES, MAX_IMAGE_PREVIEW_BYTES } from '../../src/core/chat_file_limits.ts';
import { profileStats } from '../../src/core/profile_stats.ts';

test('saving a verified image preview writes cached bytes without contacting its author', async () => {
  const dom = setupTestDOM();
  const service = RoomService.getInstance() as any;
  const previousManager = service.roomManager;
  const previousMessages = service.chatMessages;
  const previousProgress = service.fileProgress;
  const previousPreviews = service.imagePreviews;
  const previousBytes = service.imagePreviewBytes;
  const previousSaved = service.savedDownloads;
  const previousFetch = globalThis.fetch;
  const content = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const writes: Uint8Array[] = [];
  const previousStats = profileStats.get();
  let peerRequested = false;
  try {
    service.roomManager = { requestFile: async () => { peerRequested = true; throw new Error('unexpected peer request'); } };
    service.chatMessages = [{ id: 'image', sender: 'Alice', file: {
      name: 'image.png', size: content.length, sha256: 'a'.repeat(64), isImage: true,
    } }];
    service.fileProgress = {};
    service.imagePreviews = {};
    service.imagePreviewBytes = {};
    service.savedDownloads = {};
    (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command === 'choose_chat_download') return true;
      if (command === 'write_chat_download_chunk') {
        const bytes = Uint8Array.from(Buffer.from(args.data, 'base64'));
        writes.push(bytes);
        return args.offset + bytes.length;
      }
      if (command === 'finish_chat_download') return 'C:\\Downloads\\image.png';
      throw new Error(`Unexpected native command: ${command}`);
    } };
    globalThis.fetch = async () => { throw new Error('preview URL must not be fetched'); };
    service.recordFileProgress({ requestId: 'preview', messageId: 'image', direction: 'receive',
      bytes: content.length, total: content.length, status: 'complete', previewOnly: true,
      preview: 'blob:verified', previewBytes: content });

    const requestId = await service.requestFile('image', false);
    assert.ok(requestId);
    assert.equal(peerRequested, false);
    assert.deepEqual(Buffer.concat(writes), Buffer.from(content));
    assert.equal(service.savedDownloads.image, requestId);
    assert.deepEqual(profileStats.get(), previousStats, 'Cached image previews and local saves cannot count as network transfers');
  } finally {
    globalThis.fetch = previousFetch;
    service.roomManager = previousManager;
    service.chatMessages = previousMessages;
    service.fileProgress = previousProgress;
    service.imagePreviews = previousPreviews;
    service.imagePreviewBytes = previousBytes;
    service.savedDownloads = previousSaved;
    dom.cleanup();
  }
});

test('own clipboard images save locally, restore their source, and never request a peer transfer', async () => {
  const dom = setupTestDOM();
  const service = RoomService.getInstance() as any;
  const previous = { manager: service.roomManager, messages: service.chatMessages, progress: service.fileProgress,
    bytes: service.imagePreviewBytes, saved: service.savedDownloads };
  const manager = new GroupRoomManager('Alice', 'own-images', '', false) as any;
  const size = MAX_IMAGE_PREVIEW_BYTES + 1;
  const source = { id: 'clipboard-source', name: 'clipboard.png', path: 'C:\\AppData\\clipboard.png',
    size, hash: 'a'.repeat(64), isImage: true };
  const message = { id: 'own-image', sender: 'Alice', authorKey: 'local-key',
    file: { name: 'my-print.png', size, sha256: source.hash, isImage: true } };
  manager.chatAuth = { publicKey: 'local-key' };
  manager.chatHistory = [message];
  let peerRequests = 0, restored = 0, written = 0, chunks = 0, cancelled = 0;
  let choose = true, changed = false, cancelDuringRead = false;
  const previousStats = profileStats.get();
  const destinations: boolean[] = [];
  manager.requestFile = async () => { peerRequests++; throw new Error('Self transfer is forbidden'); };
  try {
    service.roomManager = manager; service.chatMessages = [message]; service.fileProgress = {};
    service.imagePreviewBytes = {}; service.savedDownloads = {};
    (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command === 'restore_chat_file_source') { restored++; assert.equal(args.messageId, message.id); return source; }
      if (command === 'inspect_chat_file') return { ...source, hash: changed ? 'b'.repeat(64) : source.hash };
      if (command === 'choose_chat_download') {
        destinations.push(args.saveAs); assert.equal(args.name, 'my-print.png'); written = 0; return choose;
      }
      if (command === 'read_chat_file_chunk') {
        assert.equal(args.id, source.id); assert.ok(args.length <= CHAT_FILE_CHUNK_BYTES);
        if (cancelDuringRead) {
          const active = Object.keys(service.fileProgress).find(id => service.localSaveIds.has(id));
          await service.cancelFileTransfer(active);
        }
        return Buffer.alloc(args.length, 0x42).toString('base64');
      }
      if (command === 'write_chat_download_chunk') {
        assert.equal(args.offset, written); written += Buffer.from(args.data, 'base64').length; chunks++; return written;
      }
      if (command === 'finish_chat_download') { assert.equal(written, size); return 'C:\\Downloads\\my-print.png'; }
      if (command === 'cancel_chat_download') { cancelled++; return; }
      throw new Error(`Unexpected command: ${command}`);
    } };
    const requestId = await service.requestFile(message.id, false);
    assert.ok(requestId); assert.equal(restored, 1); assert.equal(peerRequests, 0);
    assert.ok(chunks > 1); assert.equal(written, size); assert.equal(service.savedDownloads[message.id], requestId);
    assert.equal(service.fileProgress[requestId].status, 'complete');
    choose = false;
    assert.equal(await service.requestFile(message.id, true), null);
    assert.deepEqual(destinations, [false, true]); assert.equal(cancelled, 0);
    changed = true;
    await assert.rejects(service.requestFile(message.id, false), /Source file changed/);
    assert.equal(destinations.length, 2);
    changed = false; choose = true; cancelDuringRead = true;
    const priorChunks = chunks;
    assert.equal(await service.requestFile(message.id, false), null);
    assert.equal(chunks, priorChunks); assert.equal(cancelled, 1); assert.equal(peerRequests, 0);
    assert.deepEqual(profileStats.get(), previousStats, 'Saving an own image cannot count as received data');
  } finally {
    service.roomManager = previous.manager; service.chatMessages = previous.messages; service.fileProgress = previous.progress;
    service.imagePreviewBytes = previous.bytes; service.savedDownloads = previous.saved;
    dom.cleanup();
  }
});

test('local source access rejects deleted own offers and ignores remote images', async () => {
  const manager = new GroupRoomManager('Alice', 'own-source-authorization', '', false) as any;
  manager.chatAuth = { publicKey: 'local-key' };
  manager.chatHistory = [
    { id: 'remote', authorKey: 'remote-key', file: { isImage: true } },
    { id: 'deleted', authorKey: 'local-key', deletedAt: 1, file: { isImage: true } },
  ];
  assert.equal(await manager.getOwnImageSource('remote'), null);
  assert.equal(await manager.getOwnImageSource('missing'), null);
  await assert.rejects(manager.getOwnImageSource('deleted'), /Image offer unavailable/);
});
