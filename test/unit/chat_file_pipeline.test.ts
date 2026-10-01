import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GroupRoomManager } from '../../src/p2p/group_room.ts';
import { CHAT_FILE_CHUNK_BYTES } from '../../src/core/chat_file_limits.ts';

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
  assert.deepEqual(acknowledgments, [first.length, session.total]);
  assert.deepEqual(Buffer.concat(session.chunks), Buffer.concat([first, second]));
});
