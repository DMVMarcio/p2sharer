import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getConnectedPeerHealth, SharedPeerManager } from '../../node_modules/@trystero-p2p/core/dist/shared-peer.mjs';

function fixture(context) {
  const manager = new SharedPeerManager();
  const senders = [];
  const peer = {
    isDead: false, created: 0, connection: { connectionState: 'connected', iceConnectionState: 'connected', getSenders: () => senders },
    channel: { readyState: 'open' }, setHandlers() {}, sendData() {}, destroy() { this.isDead = true; },
    addStream(stream) { for (const track of stream.getTracks()) this.addTrack(track, stream); },
    removeStream(stream) { for (const track of stream.getTracks()) this.removeTrack(track); },
    addTrack(track) { if (!senders.some(sender => sender.track === track)) senders.push({ track }); },
    removeTrack(track) { const index = senders.findIndex(sender => sender.track === track); if (index >= 0) senders.splice(index, 1); },
  };
  const shared = manager.register('app', 'viewer', peer, 60000);
  const bind = () => manager.bind('room', Promise.resolve('token'), shared, { onDetach() {} }).proxy;
  const track = { id: 'video', readyState: 'live' };
  const stream = { getTracks: () => [track] };
  context.after(() => manager.clear('app', 'viewer', { destroyPeer: true }));
  return { manager, shared, senders, bind, stream, track };
}

test('a retired room proxy cannot remove media or detach a replacement binding with the same room ID', context => {
  const f = fixture(context);
  const retired = f.bind();
  retired.addStream(f.stream);
  retired.destroy();
  const current = f.bind();
  current.addStream(f.stream);
  retired.removeStream(f.stream);
  retired.removeTrack(f.track);
  retired.destroy();
  assert.equal(f.shared.bindings.room.proxy, current);
  assert.deepEqual(f.senders.map(sender => sender.track), [f.track]);
  current.removeStream(f.stream);
  retired.addStream(f.stream);
  retired.addTrack(f.track, f.stream);
  assert.equal(f.senders.length, 0, 'Late publication from a retired room must not resurrect senders');
});

test('recovery rechecks real senders even when stream ownership is already registered', context => {
  const f = fixture(context);
  const current = f.bind();
  current.addStream(f.stream);
  f.senders.length = 0; // A prior native handoff or SDP removal retired the sender.
  current.addStream(f.stream);
  assert.deepEqual(f.senders.map(sender => sender.track), [f.track]);
  current.addStream(f.stream);
  assert.equal(f.senders.length, 1);
});

test('connected peer health marks ICE-disconnected peers as transient so remote reconnects are not ignored', () => {
  const base = {
    isDead: false,
    channel: { readyState: 'open' },
    connection: { connectionState: 'connected', iceConnectionState: 'connected' },
  };
  assert.equal(getConnectedPeerHealth(base), 'live');
  assert.equal(getConnectedPeerHealth({ ...base, connection: { connectionState: 'disconnected', iceConnectionState: 'connected' } }), 'transient');
  assert.equal(getConnectedPeerHealth({ ...base, connection: { connectionState: 'connected', iceConnectionState: 'disconnected' } }), 'transient');
  assert.equal(getConnectedPeerHealth({ ...base, connection: { connectionState: 'failed', iceConnectionState: 'failed' } }), 'stale');
});
