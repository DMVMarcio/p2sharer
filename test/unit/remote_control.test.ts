import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createIdleViewerState,
  decodeRemoteControlBinaryInput,
  decodeRemoteControlCursorSync,
  encodeRemoteControlBinaryInput,
  encodeRemoteControlCursorSync,
  isRemoteControlBinaryFrame,
  normalizeCursorShape,
  validRemoteControlClientPacket,
  validRemoteControlHostPacket,
  type RemoteControlHostPacket,
  type RemoteInputEvent,
} from '../../src/core/remote_control.ts';
import { RemoteControlHostManager } from '../../src/services/remote_control_receiver.ts';

test('validRemoteControlClientPacket and validRemoteControlHostPacket validate bounds and schemas', () => {
  assert.equal(validRemoteControlClientPacket({ type: 'request', mediaId: 'screen-1' }), true);
  assert.equal(validRemoteControlClientPacket({ type: 'cancel', mediaId: 'screen-1' }), true);
  assert.equal(validRemoteControlClientPacket({ type: 'release', mediaId: 'screen-1' }), true);
  assert.equal(
    validRemoteControlClientPacket({
      type: 'input',
      mediaId: 'screen-1',
      event: { kind: 'mouseMove', x: 0.5, y: 0.25 },
    }),
    true,
  );
  assert.equal(
    validRemoteControlClientPacket({
      type: 'input',
      mediaId: 'screen-1',
      event: { kind: 'mouseMove', x: 1.5, y: 0.25 },
    }),
    false,
  );
  assert.equal(
    validRemoteControlClientPacket({
      type: 'input',
      mediaId: 'screen-1',
      event: { kind: 'mouseWheel', deltaX: 0, deltaY: Number.NaN },
    }),
    false,
  );
  assert.equal(validRemoteControlClientPacket({ type: 'request', mediaId: '' }), false);

  assert.equal(
    validRemoteControlHostPacket({
      type: 'accept',
      mediaId: 'screen-1',
      mouseEnabled: true,
      keyboardEnabled: false,
      cursorCaptured: true,
      hostBusy: false,
      cursorShape: 'pointer',
    }),
    true,
  );
  assert.equal(
    validRemoteControlHostPacket({
      type: 'state',
      mediaId: 'screen-1',
      mouseEnabled: true,
      keyboardEnabled: true,
      cursorCaptured: true,
      hostBusy: true,
      cursorShape: 'invalid-shape',
    }),
    false,
  );
  assert.equal(normalizeCursorShape('text'), 'text');
  assert.equal(normalizeCursorShape('unknown'), 'default');
  assert.equal(createIdleViewerState('screen-1', 'peer-a').status, 'idle');
});

test('RemoteControlHostManager manages consent, multi-controllers, permissions, and host priority', async () => {
  const sent: Array<{ peerId: string; packet: RemoteControlHostPacket }> = [];
  const monitorCalls: boolean[] = [];
  const applied: Array<{ controllerId: string; sessionId: string | undefined; event: RemoteInputEvent }> = [];
  const released: Array<string | undefined> = [];
  let changeCount = 0;

  const manager = new RemoteControlHostManager({
    isHostSupported: () => true,
    getScreenStream: (mediaId) =>
      mediaId === 'screen-1' ? { sessionId: 'sess-1', cursorCaptured: true } : null,
    sendToPeer: (peerId, packet) => sent.push({ peerId, packet }),
    setMonitorActive: (active) => monitorCalls.push(active),
    applyInput: async (controllerId, sessionId, event) => {
      applied.push({ controllerId, sessionId, event });
      return { accepted: true, hostBusy: false };
    },
    releaseInputs: (controllerId) => released.push(controllerId),
    onChange: () => {
      changeCount++;
    },
  });

  // 1. Request and cancel before host responds
  manager.receiveClientPacket({ type: 'request', mediaId: 'screen-1' }, 'peer-a');
  assert.equal(manager.getRequests().length, 1);
  manager.receiveClientPacket({ type: 'cancel', mediaId: 'screen-1' }, 'peer-a');
  assert.equal(manager.getRequests().length, 0);

  // 2. Two peers request: peer-a accepted, peer-b accepted (multi-controller), peer-c declined
  manager.receiveClientPacket({ type: 'request', mediaId: 'screen-1' }, 'peer-a');
  manager.receiveClientPacket({ type: 'request', mediaId: 'screen-1' }, 'peer-b');
  manager.receiveClientPacket({ type: 'request', mediaId: 'screen-1' }, 'peer-c');

  manager.answerRequest('peer-a:screen-1', true);
  manager.answerRequest('peer-b:screen-1', true);
  manager.answerRequest('peer-c:screen-1', false);

  assert.deepEqual(monitorCalls, [true]);
  assert.equal(manager.getControllers().length, 2);
  assert.equal(sent.find((entry) => entry.peerId === 'peer-c')?.packet.type, 'decline');
  assert.equal(sent.find((entry) => entry.peerId === 'peer-a')?.packet.type, 'accept');

  // 3. Per-controller permission enforcement (disable mouse for peer-a)
  manager.setControllerPermissions('peer-a', 'screen-1', { mouseEnabled: false });
  assert.equal(released.includes('peer-a:screen-1'), true);

  manager.receiveClientPacket(
    { type: 'input', mediaId: 'screen-1', event: { kind: 'mouseMove', x: 0.4, y: 0.4 } },
    'peer-a',
  );
  manager.receiveClientPacket(
    { type: 'input', mediaId: 'screen-1', event: { kind: 'key', code: 'KeyA', key: 'a', down: true } },
    'peer-a',
  );
  await Promise.resolve();

  assert.equal(applied.length, 1);
  assert.equal(applied[0].controllerId, 'peer-a:screen-1');
  assert.equal(applied[0].event.kind, 'key');

  // 4. Host priority & cursor shape propagate to all active controllers
  manager.setHostPriorityState(true, 'text');
  assert.equal(manager.isHostBusy(), true);
  const stateUpdates = sent.filter((entry) => entry.packet.type === 'state' && entry.packet.hostBusy);
  assert.equal(stateUpdates.length, 2);

  // 5. Revoking and peer disconnect drop controllers and deactivate monitor when empty
  manager.revokeController('peer-a', 'screen-1');
  assert.equal(manager.getControllers().length, 1);
  assert.deepEqual(monitorCalls, [true]);

  manager.forgetPeer('peer-b');
  assert.equal(manager.getControllers().length, 0);
  assert.deepEqual(monitorCalls, [true, false]);
  assert.ok(changeCount > 0);
});

test('encodeRemoteControlBinaryInput and decodeRemoteControlBinaryInput roundtrip events and reject malformed frames', () => {
  const samples: RemoteInputEvent[] = [
    { kind: 'mouseMove', x: 0.25, y: 0.75 },
    { kind: 'mouseDelta', dx: -45, dy: 120 },
    { kind: 'mouseButton', button: 'right', down: true, x: 0.5, y: 0.5 },
    { kind: 'mouseButton', button: 'x1', down: false },
    { kind: 'mouseWheel', deltaX: -12.5, deltaY: 120, x: 0.125, y: 0.875 },
    { kind: 'key', code: 'KeyW', key: 'w', down: true, repeat: true, ctrlKey: true, vk: 87 },
    { kind: 'releaseAll' },
  ];

  samples.forEach((event, index) => {
    const encoded = encodeRemoteControlBinaryInput('screen-1', event, index + 1);
    assert.ok(encoded instanceof Uint8Array);
    assert.equal(isRemoteControlBinaryFrame(encoded), true);
    const decoded = decodeRemoteControlBinaryInput(encoded);
    assert.ok(decoded);
    assert.equal(decoded.mediaId, 'screen-1');
    assert.equal(decoded.seq, index + 1);
    assert.equal(decoded.event.kind, event.kind);
    if (event.kind === 'mouseDelta' && decoded.event.kind === 'mouseDelta') {
      assert.equal(decoded.event.dx, -45);
      assert.equal(decoded.event.dy, 120);
    }
    if (event.kind === 'key' && decoded.event.kind === 'key') {
      assert.equal(decoded.event.code, 'KeyW');
      assert.equal(decoded.event.vk, 87);
      assert.equal(decoded.event.ctrlKey, true);
      assert.equal(decoded.event.repeat, true);
    }
  });

  // Malformed or truncated buffers are rejected cleanly
  assert.equal(decodeRemoteControlBinaryInput(new Uint8Array([0x00, 0x05, 0x7b])), null);
  assert.equal(decodeRemoteControlBinaryInput(new Uint8Array([0x52, 0x43, 0x01, 1, 2, 65, 66, 0, 0, 0, 1])), null);
  assert.equal(encodeRemoteControlBinaryInput('', { kind: 'releaseAll' }), null);

  const cursorPacket: Extract<RemoteControlHostPacket, { type: 'cursorSync' }> = {
    type: 'cursorSync',
    mediaId: 'screen-1',
    active: true,
    visible: true,
    x: 0.375,
    y: 0.625,
    cursorShape: 'pointer',
    imageId: '0123456789abcdef',
    mouseLocked: true,
    hostBusy: false,
    actorPeerId: 'peer-a',
    embeddedInVideo: false,
  };
  assert.equal(validRemoteControlHostPacket(cursorPacket), true);
  assert.equal(
    validRemoteControlHostPacket({
      type: 'cursorImage',
      mediaId: 'screen-1',
      imageId: '0123456789abcdef',
      width: 32,
      height: 32,
      hotX: 4,
      hotY: 2,
      pngBase64: 'iVBORw0KGgo=',
    }),
    true,
  );
  const encodedCursor = encodeRemoteControlCursorSync(cursorPacket, 42);
  assert.ok(encodedCursor instanceof Uint8Array);
  assert.equal(isRemoteControlBinaryFrame(encodedCursor), true);
  assert.equal(decodeRemoteControlBinaryInput(encodedCursor), null);
  const decodedCursor = decodeRemoteControlCursorSync(encodedCursor);
  assert.ok(decodedCursor);
  assert.equal(decodedCursor.seq, 42);
  assert.equal(decodedCursor.packet.type, 'cursorSync');
  assert.equal(decodedCursor.packet.actorPeerId, 'peer-a');
  assert.equal(decodedCursor.packet.cursorShape, 'pointer');
  assert.equal(decodedCursor.packet.imageId, '0123456789abcdef');
  assert.equal(decodedCursor.packet.mouseLocked, true);
  assert.equal(decodedCursor.packet.embeddedInVideo, false);
});
