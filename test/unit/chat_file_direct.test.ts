import assert from 'node:assert/strict';
import { test } from 'node:test';
import { directFileAddress, directFileSignature, validDirectFileOffer } from '../../src/core/chat_file_direct.ts';
import { PeerAuthenticator } from '../../src/core/peer_auth.ts';
import { GroupRoomManager } from '../../src/p2p/group_room.ts';
import { setupTestDOM } from '../helpers/browser_mocks.ts';

const offer = { address: '192.0.2.2', port: 49152, certificate: 'AQID', token: 'a'.repeat(64) };
const stats = (type = 'host') => new Map([
  ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
  ['pair', { id: 'pair', type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote' }],
  ['local', { id: 'local', type: 'local-candidate', candidateType: 'host', address: '192.0.2.1' }],
  ['remote', { id: 'remote', type: 'remote-candidate', candidateType: type, address: '192.0.2.2' }],
]);
const connection = (type = 'host') => ({ connectionState: 'connected', getStats: async () => stats(type) }) as unknown as RTCPeerConnection;

test('direct transport uses only selected usable host routes and bounded capabilities', async () => {
  assert.equal(await directFileAddress(connection(), 'remote'), '192.0.2.2');
  assert.equal(await directFileAddress(connection('relay'), 'remote'), null);
  assert.equal(await directFileAddress(connection('srflx'), 'remote'), null);
  assert.equal(await directFileAddress(undefined, 'local'), null);
  const ipv6 = connection();
  ipv6.getStats = async () => {
    const reports = stats();
    reports.get('remote')!.address = '2001:db8::2';
    return reports as unknown as RTCStatsReport;
  };
  assert.equal(await directFileAddress(ipv6, 'remote'), '2001:0db8:0000:0000:0000:0000:0000:0002');
  assert.ok(validDirectFileOffer(offer));
  assert.ok(!validDirectFileOffer({ ...offer, port: 65536 }));
  assert.ok(!validDirectFileOffer({ ...offer, token: 'bad' }));
  assert.ok(!validDirectFileOffer({ ...offer, address: '127.0.0.1' }));
  assert.ok(!validDirectFileOffer({ ...offer, address: 'https://example.org' }));
  assert.ok(!validDirectFileOffer({ ...offer, certificate: 'a'.repeat(8193) }));
});

test('signed acceptance binds every native capability field', async () => {
  const auth = await PeerAuthenticator.create('file-direct-test', 'sender');
  const data = (value: typeof offer) => ['accept', 'request', 'message', null, false, directFileSignature(value)];
  const signature = await auth.signControl('chat-file-control-v3', data(offer));
  assert.ok(await auth.verifyControl('chat-file-control-v3', data(offer), signature, auth.publicKey));
  for (const changed of [{ ...offer, address: '192.0.2.3' }, { ...offer, port: 49153 }, { ...offer, certificate: 'BAUG' }, { ...offer, token: 'b'.repeat(64) }]) {
    assert.ok(!await auth.verifyControl('chat-file-control-v3', data(changed), signature, auth.publicKey));
  }
});

test('signed endpoints survive hidden peer-reflexive stats without treating IPv4 NAT mappings as TCP routes', async () => {
  const pc = connection('prflx');
  pc.getStats = async () => {
    const reports = stats('prflx');
    reports.get('local')!.address = '2001:db8::1';
    delete (reports.get('remote') as any).address;
    return reports as unknown as RTCStatsReport;
  };
  assert.equal(await directFileAddress(pc, 'local'), '2001:0db8:0000:0000:0000:0000:0000:0001');
  assert.equal(await directFileAddress(pc, 'remote', '2001:db8::2'), '2001:0db8:0000:0000:0000:0000:0000:0002');
  assert.equal(await directFileAddress(pc, 'remote', '192.0.2.2'), null);
  assert.equal(await directFileAddress(pc, 'remote', '127.0.0.1', true), null);
  assert.equal(await directFileAddress(connection(), 'remote', '192.0.2.3'), null);
  const hiddenV4 = connection('prflx');
  hiddenV4.getStats = async () => {
    const reports = stats('prflx');
    delete (reports.get('remote') as any).address;
    return reports as unknown as RTCStatsReport;
  };
  assert.equal(await directFileAddress(hiddenV4, 'local'), null);
  assert.equal(await directFileAddress(hiddenV4, 'local', undefined, true), '192.0.2.1');
});

test('direct transport falls back only before any destination bytes have been written', async () => {
  const dom = setupTestDOM();
  try {
    const manager = new GroupRoomManager('Receiver', 'file-direct-test', '', false) as any;
    manager.room = { getPeers: () => ({ sender: connection() }) };
    let result = { bytes: 0, error: 'Connection refused' };
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1, invoke: async (command: string) => {
      assert.equal(command, 'receive_direct_chat_file');
      return result;
    } };
    const session = { peerId: 'sender', messageId: 'message', direction: 'receive', total: 100, offset: 0 };
    manager.fileSessions.set('request', session);
    assert.equal(await manager.tryReceiveDirectFile('request', session, {}, offer), false);
    assert.equal((session as any).direct, false);
    result = { bytes: 40, error: 'Connection interrupted' };
    await assert.rejects(manager.tryReceiveDirectFile('request', session, {}, offer), /interrupted/);
    assert.equal(session.offset, 40);
  } finally { dom.cleanup(); }
});

test('native completion checks the file before sending its final acknowledgment', async () => {
  const dom = setupTestDOM();
  try {
    const manager = new GroupRoomManager('Receiver', 'file-direct-test', '', false) as any;
    manager.room = { getPeers: () => ({ sender: connection() }) };
    (window as any).__TAURI_INTERNALS__ = { transformCallback: () => 1,
      invoke: async () => ({ bytes: 100, error: null }) };
    const session = { peerId: 'sender', messageId: 'message', direction: 'receive', total: 100, offset: 0 };
    manager.fileSessions.set('request', session);
    const order: string[] = [];
    manager.finishReceivedFile = async () => { order.push('verify'); manager.fileSessions.delete('request'); };
    manager.sendFilePacket = async (_peer: string, packet: any) => { assert.equal(packet.offset, 100); order.push('ack'); };
    assert.equal(await manager.tryReceiveDirectFile('request', session, {}, offer), true);
    assert.deepEqual(order, ['verify', 'ack']);
  } finally { dom.cleanup(); }
});

test('signed WebRTC fallback closes the native offer and avoids retrying a blocked route for every file', async () => {
  const dom = setupTestDOM();
  try {
    const manager = new GroupRoomManager('Sender', 'file-direct-test', '', false) as any;
    const owner = await PeerAuthenticator.create('file-direct-test', 'sender');
    const receiver = await PeerAuthenticator.create('file-direct-test', 'receiver');
    manager.chatAuth = owner;
    manager.chatAuth.getKnownKey = () => receiver.publicKey;
    const pc = connection();
    manager.room = { getPeers: () => ({ receiver: pc }) };
    manager.chatHistory = [{ id: 'message', authorKey: owner.publicKey, file: { size: 100 } }];
    const session = { peerId: 'receiver', messageId: 'message', direction: 'send', total: 100,
      offset: 0, sentOffset: 100, direct: true };
    manager.fileSessions.set('request', session);
    const calls: string[] = [];
    (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string) => { calls.push(command); } };
    manager.fileBulk = { ready: async () => { calls.push('ready'); } };
    manager.sendNextFileChunks = async () => { calls.push('send'); };
    const signature = await receiver.signControl('chat-file-control-v3', ['ready', 'request', 'message', null, false, null]);
    await manager.handleFilePacket({ kind: 'ready', requestId: 'request', messageId: 'message', signature }, 'receiver');
    assert.deepEqual(calls, ['cancel_direct_chat_file', 'ready', 'send']);
    assert.equal(session.direct, false);
    assert.equal(session.sentOffset, 0);
    assert.ok(manager.fileDirectRetryAfter.get(pc) > Date.now());
  } finally { dom.cleanup(); }
});
