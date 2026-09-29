import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupTestDOM } from '../e2e/harness/dom-mock.ts';
import { RoomService } from '../../src/services/room_service.ts';

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
