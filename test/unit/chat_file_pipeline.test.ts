import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GroupRoomManager } from '../../src/p2p/group_room.ts';
import { CHAT_FILE_CHUNK_BYTES, CHAT_FILE_IO_BATCH_BYTES, CHAT_FILE_IN_FLIGHT_CHUNKS } from '../../src/core/chat_file_limits.ts';
import { decodeSignedFileChunk, encodeSignedFileChunk, fileChunkSignatureData, hashFileChunk } from '../../src/core/chat_file_wire.ts';
import { PeerAuthenticator } from '../../src/core/peer_auth.ts';
import { setupTestDOM } from '../helpers/browser_mocks.ts';

test('pipelined image chunks are assembled in offset order before acknowledgment', async () => {
  const manager = new GroupRoomManager('Receiver', 'file-pipeline-test', '', false) as any;
  const first = Buffer.alloc(CHAT_FILE_CHUNK_BYTES, 0x11);
  const second = Buffer.alloc(7, 0x22);
  const acknowledgments: number[] = [];
  const session = {
    messageId: 'file-message', peerId: 'sender', offset: 0, total: first.length + second.length,
    direction: 'receive', preview: true, chunks: [], pendingChunks: new Map(),
    timings: { readMs: 0, prepareMs: 0, wireMs: 0, verifyMs: 0, writeMs: 0, ackMs: 0 },
  };
  manager.fileSessions.set('request', session);
  manager.sendFilePacket = async (_peerId: string, packet: { offset: number }) => { acknowledgments.push(packet.offset); };
  manager.emitFileProgress = () => {};
  manager.finishReceivedFile = async () => { manager.fileSessions.delete('request'); };
  const message = { id: 'file-message', file: { name: 'photo.png', size: session.total } };

  session.pendingChunks.set(first.length, new Uint8Array(second));
  await manager.processReceivedFileChunks('request', session, message);
  assert.equal(session.offset, 0);
  assert.deepEqual(acknowledgments, []);

  session.pendingChunks.set(0, new Uint8Array(first));
  await manager.processReceivedFileChunks('request', session, message);
  assert.deepEqual(acknowledgments, [session.total]);
  assert.deepEqual(Buffer.concat(session.chunks), Buffer.concat([first, second]));
});

const timings = () => ({ readMs: 0, prepareMs: 0, wireMs: 0, verifyMs: 0, writeMs: 0, ackMs: 0 });

test('sender batches native reads while keeping signed wire chunks and the acknowledgment window bounded', async () => {
  const dom = setupTestDOM();
  try {
    const manager = new GroupRoomManager('Sender', 'file-batch-test', '', false) as any;
    const auth = await PeerAuthenticator.create('file-batch-test', 'sender');
    manager.chatAuth = auth;
    manager.fileAction = {};
    manager.peerTracker.isVerified = () => true;
    const total = CHAT_FILE_CHUNK_BYTES * CHAT_FILE_IN_FLIGHT_CHUNKS + 7;
    const source = Buffer.alloc(total, 0x35);
    const session = { messageId: 'message', peerId: 'receiver', sourceId: 'source',
      direction: 'send', offset: 0, sentOffset: 0, total, timings: timings() };
    manager.fileSessions.set('request', session);
    const reads: number[] = [];
    const packets: Uint8Array[] = [];
    (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      assert.equal(command, 'read_chat_file_bytes');
      reads.push(args.length);
      return Uint8Array.from(source.subarray(args.offset, args.offset + args.length)).buffer;
    } };
    manager.fileBulk = { send: async (_peer: string, packet: Uint8Array) => { packets.push(packet); } };
    await manager.sendNextFileChunks('request');
    assert.equal(session.sentOffset, CHAT_FILE_CHUNK_BYTES * CHAT_FILE_IN_FLIGHT_CHUNKS);
    assert.equal(reads.length, Math.ceil(session.sentOffset / CHAT_FILE_IO_BATCH_BYTES));
    assert.equal(packets.length, CHAT_FILE_IN_FLIGHT_CHUNKS);
    session.offset = session.sentOffset;
    await manager.sendNextFileChunks('request');
    assert.equal(session.sentOffset, total);
    assert.equal(reads.at(-1), 7);
    const chunks = [];
    for (const packet of packets) {
      const decoded = decodeSignedFileChunk(packet)!;
      assert.ok(decoded);
      assert.ok(packet.length < 16 * 1024);
      assert.equal(decoded.header.offset, chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      assert.ok(await auth.verifyControl('chat-file-chunk-v2', [decoded.header.requestId,
        decoded.header.messageId, decoded.header.offset, decoded.header.hash], decoded.header.signature, auth.publicKey));
      chunks.push(decoded.bytes);
    }
    assert.deepEqual(Buffer.concat(chunks), source);
  } finally { dom.cleanup(); }
});

test('receiver coalesces contiguous verified chunks and acknowledges only completed native writes', async () => {
  const dom = setupTestDOM();
  try {
    const manager = new GroupRoomManager('Receiver', 'file-write-test', '', false) as any;
    const source = Buffer.alloc(CHAT_FILE_IO_BATCH_BYTES + CHAT_FILE_CHUNK_BYTES + 3, 0x73);
    const session = { messageId: 'message', peerId: 'sender', direction: 'receive', offset: 0,
      total: source.length, pendingChunks: new Map(), timings: timings() };
    for (let offset = 0; offset < source.length; offset += CHAT_FILE_CHUNK_BYTES)
      session.pendingChunks.set(offset, source.subarray(offset, offset + CHAT_FILE_CHUNK_BYTES));
    manager.fileSessions.set('request', session);
    const writes: Uint8Array[] = [];
    const acks: number[] = [];
    let written = 0;
    (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, bytes: Uint8Array, options: any) => {
      assert.equal(command, 'write_chat_download_bytes');
      assert.equal(options.headers['x-chat-download-id'], 'request');
      assert.equal(Number(options.headers['x-chat-offset']), written);
      assert.ok(bytes instanceof Uint8Array);
      assert.equal(session.offset, written);
      assert.ok(bytes.length <= 256 * 1024);
      assert.equal(session.writingUntil, written + bytes.length);
      writes.push(bytes); written += bytes.length;
      return written;
    } };
    manager.sendFilePacket = async (_peer: string, packet: any) => {
      assert.equal(packet.offset, written); acks.push(packet.offset);
    };
    manager.emitFileProgress = () => {};
    manager.finishReceivedFile = async () => { manager.fileSessions.delete('request'); };
    await manager.processReceivedFileChunks('request', session, { id: 'message' });
    assert.deepEqual(Buffer.concat(writes), source);
    assert.deepEqual(acks, [CHAT_FILE_IO_BATCH_BYTES, source.length]);
  } finally { dom.cleanup(); }
});

test('cancelling during a batched native read prevents preparation and transmission', async () => {
  const dom = setupTestDOM();
  try {
    const manager = new GroupRoomManager('Sender', 'file-cancel-test', '', false) as any;
    manager.fileSessions.set('request', { messageId: 'message', peerId: 'receiver', sourceId: 'source',
      direction: 'send', offset: 0, sentOffset: 0, total: CHAT_FILE_IO_BATCH_BYTES, timings: timings() });
    (window as any).__TAURI_INTERNALS__ = { invoke: async () => {
      manager.fileSessions.delete('request');
      return new ArrayBuffer(CHAT_FILE_IO_BATCH_BYTES);
    } };
    manager.prepareFileChunk = () => { assert.fail('Cancelled reads must not prepare packets'); };
    await manager.sendNextFileChunks('request');
    assert.equal(manager.fileSessions.size, 0);
  } finally { dom.cleanup(); }
});

test('a valid next block arriving while an acknowledgment is pending is queued rather than discarded', async () => {
  const manager = new GroupRoomManager('Receiver', 'file-ack-race-test', '', false) as any;
  const author = await PeerAuthenticator.create('file-ack-race-test', 'sender');
  manager.chatAuth = await PeerAuthenticator.create('file-ack-race-test', 'receiver');
  manager.chatAuth.pinDirect('sender', author.publicKey);
  manager.peerTracker.isVerified = () => true;
  const first = Buffer.alloc(CHAT_FILE_CHUNK_BYTES, 0x11);
  const second = Buffer.from([0x22, 0x33]);
  const session = { messageId: 'message', peerId: 'sender', direction: 'receive', offset: 0,
    total: first.length + second.length, preview: true, chunks: [], timings: timings() };
  const message = { id: 'message', authorKey: author.publicKey, file: { size: session.total } };
  manager.chatHistory = [message];
  manager.fileSessions.set('request', session);
  let acknowledge!: () => void;
  let firstAckStarted!: () => void;
  const ackStarted = new Promise<void>(resolve => { firstAckStarted = resolve; });
  const ackPending = new Promise<void>(resolve => { acknowledge = resolve; });
  const acks: number[] = [];
  manager.sendFilePacket = async (_peer: string, packet: any) => {
    acks.push(packet.offset);
    if (acks.length === 1) { firstAckStarted(); await ackPending; }
  };
  manager.emitFileProgress = () => {};
  manager.finishReceivedFile = async () => { manager.fileSessions.delete('request'); };
  const wire = async (offset: number, bytes: Uint8Array) => {
    const unsigned = { requestId: 'request', messageId: 'message', offset, hash: await hashFileChunk(bytes) };
    return encodeSignedFileChunk({ ...unsigned,
      signature: await author.signControl('chat-file-chunk-v2', fileChunkSignatureData(unsigned)) }, bytes);
  };
  const processing = manager.handleFileChunkWire(await wire(0, first), 'sender');
  await ackStarted;
  try {
    await manager.handleFileChunkWire(await wire(first.length, second), 'sender');
    assert.equal(session.offset, first.length);
    assert.equal(manager.fileSessions.get('request').pendingChunks.get(first.length)?.length, second.length);
  } finally { acknowledge(); await processing; }
  assert.equal(session.offset, session.total);
  assert.deepEqual(Buffer.concat(session.chunks), Buffer.concat([first, second]));
  assert.deepEqual(acks, [first.length, session.total]);
});
