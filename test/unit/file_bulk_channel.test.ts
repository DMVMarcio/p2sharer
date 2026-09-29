import assert from 'node:assert/strict';
import test from 'node:test';
import { FileBulkChannelManager } from '../../src/p2p/file_bulk_channel.ts';

class FakeChannel extends EventTarget {
  public readyState: RTCDataChannelState = 'connecting';
  public bufferedAmount = 0;
  public bufferedAmountLowThreshold = 0;
  public binaryType: BinaryType = 'blob';
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onclose: (() => void) | null = null;
  public sent: Uint8Array[] = [];

  public send(packet: Uint8Array): void {
    this.sent.push(packet);
  }

  public close(): void {
    this.readyState = 'closed';
    this.onclose?.();
    this.dispatchEvent(new Event('close'));
  }
}

test('bulk file channel waits for both peers to finish their signed ready handshake', async () => {
  const channel = new FakeChannel();
  let options: RTCDataChannelInit | undefined;
  const connection = {
    connectionState: 'connected', sctp: { maxMessageSize: 65536 },
    createDataChannel: (_label: string, init: RTCDataChannelInit) => { options = init; return channel; },
  } as unknown as RTCPeerConnection;
  const received: Uint8Array[] = [];
  const manager = new FileBulkChannelManager(() => connection, (_peerId, bytes) => received.push(bytes));
  manager.ensure('peer');
  assert.deepEqual(options, { negotiated: true, id: 42, ordered: false });
  assert.equal(channel.binaryType, 'arraybuffer');
  assert.equal(channel.bufferedAmountLowThreshold, 1024 * 1024);
  const packet = new Uint8Array([1, 2, 3]);
  const pending = manager.send('peer', packet, () => true);
  assert.equal(channel.sent.length, 0);
  channel.readyState = 'open';
  channel.dispatchEvent(new Event('open'));
  await pending;
  assert.deepEqual(channel.sent, [packet]);
  channel.onmessage?.(new MessageEvent('message', { data: packet.buffer }));
  assert.deepEqual(received, [packet]);
});

test('bulk file channel rejects messages beyond the negotiated WebRTC limit', async () => {
  const channel = new FakeChannel();
  channel.readyState = 'open';
  const connection = {
    connectionState: 'connected', sctp: { maxMessageSize: 1024 },
    createDataChannel: () => channel,
  } as unknown as RTCPeerConnection;
  const manager = new FileBulkChannelManager(() => connection, () => {});
  manager.ensure('peer');
  await assert.rejects(manager.send('peer', new Uint8Array(1025), () => true),
    /exceeds WebRTC message limit/);
  assert.equal(channel.sent.length, 0);
});

test('bulk channel does not restart without a new receiver handshake', async () => {
  const channel = new FakeChannel();
  channel.readyState = 'open';
  const connection = {
    connectionState: 'connected', createDataChannel: () => channel,
  } as unknown as RTCPeerConnection;
  const manager = new FileBulkChannelManager(() => connection, () => {});
  manager.ensure('peer');
  manager.close('peer');
  await assert.rejects(manager.send('peer', new Uint8Array([1]), () => true),
    /unavailable/);
});
