import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePeerPayload, decodePeerPayload } from '../../src/core/peer_payload.ts';
import { PeerPayloadChannels } from '../../src/p2p/peer_payload_channels.ts';

class Channel extends EventTarget {
  readyState = 'open'; bufferedAmount = 0; bufferedAmountLowThreshold = 0; binaryType = 'blob';
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: Uint8Array[] = [];
  send(frame: Uint8Array) { this.sent.push(frame); }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
}
function fixture() {
  const channels: Channel[] = [], options: RTCDataChannelInit[] = [], received: Uint8Array[] = [];
  let connection = { connectionState: 'connected', sctp: { maxMessageSize: 65536 },
    createDataChannel: (_label: string, init: RTCDataChannelInit) => { options.push(init); const channel = new Channel(); channels.push(channel); return channel; } };
  const manager = new PeerPayloadChannels(() => connection as unknown as RTCPeerConnection, (_peer, _lane, bytes) => received.push(bytes));
  manager.ensure('peer');
  return { manager, channels, options, received, replace: () => { connection = { ...connection }; } };
}
test('binary payloads preserve metadata, empty UDP datagrams and exact bytes within bounds', () => {
  for (const bytes of [new Uint8Array(), new Uint8Array([0,255,128]), new Uint8Array(65507)]) {
    const header = { type: 'wire', packet: { kind: 'datagram', sequence: 3 } };
    const decoded = decodePeerPayload(encodePeerPayload(header, bytes))!;
    assert.deepEqual(decoded.header, header); assert.deepEqual(decoded.bytes, bytes);
  }
  assert.throws(() => encodePeerPayload({}, new Uint8Array(65508)));
  assert.throws(() => encodePeerPayload({ long: 'x'.repeat(2048) }));
  for (const bytes of [[], [0], [8,0], [0,2,91,93], [0,1,255]]) assert.equal(decodePeerPayload(new Uint8Array(bytes)), null);
});
test('game datagrams avoid retransmission and congestion never queues them behind bulk images', async () => {
  const f = fixture(); const packet = new Uint8Array([1,2]);
  assert.equal(f.options[2].ordered, false); assert.equal(f.options[2].maxRetransmits, 0);
  assert.equal(f.options[0].ordered, true); assert.equal(f.options[1].ordered, true);
  f.channels[0].bufferedAmount = 200000;
  assert.equal(await f.manager.send('peer', 'datagram', packet, () => true), true);
  assert.equal(f.channels[2].sent.length, 1);
  f.channels[2].bufferedAmount = 20000;
  await f.manager.send('peer', 'datagram', packet, () => true);
  assert.equal(f.channels[2].sent.length, 1);
  f.manager.closeAll();
});
test('reliable tunnel traffic applies backpressure and rejects a removed peer while waiting', async () => {
  const f = fixture(), channel = f.channels[1];
  channel.bufferedAmount = 100000;
  const pending = f.manager.send('peer', 'tunnel', new Uint8Array([1]), () => true);
  await Promise.resolve();
  assert.equal(channel.sent.length, 0);
  f.manager.close('peer');
  await assert.rejects(pending, /closed|unavailable/);
});
test('stale connections cannot deliver or transmit payloads into a replacement peer session', async () => {
  const f = fixture(), frame = new Uint8Array([1]);
  f.replace();
  f.channels[2].onmessage?.(new MessageEvent('message', { data: frame.buffer }));
  assert.equal(f.received.length, 0);
  await assert.rejects(f.manager.send('peer', 'tunnel', frame, () => true), /unavailable/);
  f.manager.closeAll();
});
