import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setMaxListeners } from 'node:events';
import { createActionWireManager } from '../../node_modules/@trystero-p2p/core/dist/action-wire.mjs';

test('concurrent room actions recheck the shared channel budget after every drain', async () => {
  const received = [];
  const receiver = createActionWireManager({ getPeer: () => undefined, getPeerIds: () => [],
    canReceiveFromPeer: () => true, throwIfAborted() {} });
  for (const type of ['join-snapshot-0', 'join-snapshot-1']) receiver.makeInternalAction(type).onMessage(payload => received.push(payload));
  const channel = new EventTarget();
  setMaxListeners(0, channel);
  Object.assign(channel, { readyState: 'open', bufferedAmount: 0, bufferedAmountLowThreshold: 16_384 });
  let draining = false, peak = 0;
  const peer = { channel, sendData(frame) {
    if (channel.bufferedAmount + frame.byteLength > 65_536) throw new DOMException('RTCDataChannel send queue is full', 'OperationError');
    channel.bufferedAmount += frame.byteLength;
    peak = Math.max(peak, channel.bufferedAmount);
    receiver.handleData('sender', frame.buffer);
    if (!draining) {
      draining = true;
      setImmediate(() => { draining = false; channel.bufferedAmount = 0; channel.dispatchEvent(new Event('bufferedamountlow')); });
    }
  } };
  const createSender = id => createActionWireManager({ getPeer: () => peer, getPeerIds: () => ['receiver'],
    canReceiveFromPeer: () => true, throwIfAborted() {} }).makeInternalAction(`join-snapshot-${id}`);
  // Two room bindings can share one physical WebRTC data channel.
  const senders = [createSender(0), createSender(1)];
  const payloads = Array.from({ length: 40 }, (_, id) => JSON.stringify({ id, data: 'x'.repeat(50_000) }));
  const results = await Promise.allSettled(payloads.map((payload, id) => senders[id % 2].send(payload, 'receiver')));
  assert.equal(results.filter(result => result.status === 'rejected').length, 0);
  assert.ok(peak <= channel.bufferedAmountLowThreshold + 16_384);
  assert.equal(received.length, payloads.length);
  assert.deepEqual(received.sort(), payloads.sort());
});

test('closing a congested channel retires the pending send without writing another chunk', async () => {
  const channel = new EventTarget();
  Object.assign(channel, { readyState: 'open', bufferedAmount: 65_536, bufferedAmountLowThreshold: 16_384 });
  const peer = { channel, sendData() { assert.fail('A closed channel must not receive queued chunks'); } };
  const sender = createActionWireManager({ getPeer: () => peer, getPeerIds: () => ['receiver'],
    canReceiveFromPeer: () => true, throwIfAborted() {} }).makeInternalAction('snapshot');
  const pending = sender.send('content', 'receiver');
  channel.readyState = 'closed';
  channel.dispatchEvent(new Event('close'));
  await pending;
});
