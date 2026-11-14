import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createIdleViewerState,
  decodeRemoteControlBinaryInput,
  decodeRemoteControlCursorSync,
  encodeRemoteControlBinaryInput,
  encodeRemoteControlCursorSync,
  hasMeaningfulGamepadInput,
  isRemoteControlBinaryFrame,
  normalizeCursorShape,
  readGamepadSnapshotState,
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
  assert.equal(decodedCursor.packet.elevationBlocked, false);
});

test('gamepad binary codec, W3C snapshot conversion, and elevation flag roundtrip cleanly', () => {
  const stateEvent: RemoteInputEvent = {
    kind: 'gamepadState',
    padIndex: 2,
    buttons: 0x9001,
    leftTrigger: 128,
    rightTrigger: 255,
    thumbLx: -32768,
    thumbLy: 32767,
    thumbRx: 1234,
    thumbRy: -4321,
  };
  const encodedState = encodeRemoteControlBinaryInput('screen-1', stateEvent, 77);
  assert.ok(encodedState instanceof Uint8Array);
  const decodedState = decodeRemoteControlBinaryInput(encodedState);
  assert.ok(decodedState);
  assert.equal(decodedState.mediaId, 'screen-1');
  assert.equal(decodedState.seq, 77);
  assert.deepEqual(decodedState.event, stateEvent);

  const disconnectEvent: RemoteInputEvent = { kind: 'gamepadDisconnect', padIndex: 2 };
  const encodedDisconnect = encodeRemoteControlBinaryInput('screen-1', disconnectEvent, 78);
  assert.ok(encodedDisconnect instanceof Uint8Array);
  const decodedDisconnect = decodeRemoteControlBinaryInput(encodedDisconnect);
  assert.ok(decodedDisconnect);
  assert.deepEqual(decodedDisconnect.event, disconnectEvent);

  // Idle drift below deadzone should not lazily attach a virtual controller; real press should
  const idleButtons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  assert.equal(
    hasMeaningfulGamepadInput({
      index: 0,
      buttons: idleButtons,
      axes: [0.09, -0.1, 0.02, 0.05],
    }),
    false,
  );
  const pressedButtons = idleButtons.map((b, i) => (i === 0 ? { pressed: true, value: 1 } : b));
  assert.equal(
    hasMeaningfulGamepadInput({
      index: 0,
      buttons: pressedButtons,
      axes: [0, -1, 0.5, 1],
    }),
    true,
  );

  // W3C Y axes (-1 = up, +1 = down) invert to XInput (+32767 = up, -32768 = down)
  const snapshot = readGamepadSnapshotState({
    index: 0,
    buttons: pressedButtons.map((b, i) => (i === 7 ? { pressed: true, value: 1 } : b)),
    axes: [0, -1, 0.5, 1],
  });
  assert.equal(snapshot.buttons & 0x1000, 0x1000); // A
  assert.equal(snapshot.rightTrigger, 255);
  assert.equal(snapshot.thumbLx, 0);
  assert.equal(snapshot.thumbLy, 32767);
  assert.equal(snapshot.thumbRx, Math.round(0.5 * 32767));
  assert.equal(snapshot.thumbRy, -32768);

  const elevatedCursor: Extract<RemoteControlHostPacket, { type: 'cursorSync' }> = {
    type: 'cursorSync',
    mediaId: 'screen-1',
    active: true,
    visible: false,
    x: 0.5,
    y: 0.5,
    cursorShape: 'default',
    mouseLocked: false,
    hostBusy: false,
    elevationBlocked: true,
    actorPeerId: 'peer-a',
    embeddedInVideo: false,
  };
  const encodedCursor = encodeRemoteControlCursorSync(elevatedCursor, 9);
  assert.ok(encodedCursor instanceof Uint8Array);
  const decodedCursor = decodeRemoteControlCursorSync(encodedCursor);
  assert.ok(decodedCursor);
  assert.equal(decodedCursor.packet.elevationBlocked, true);
});

test('RemoteControlHostManager enforces gamepadEnabled, syncs native peer permissions, and propagates elevationBlocked', async () => {
  const sent: Array<{ peerId: string; packet: RemoteControlHostPacket }> = [];
  const applied: RemoteInputEvent[] = [];
  const released: Array<string | undefined> = [];
  const disconnectedPads: string[] = [];
  const nativeSyncs: Array<{ peerId: string; authorized: boolean; gamepadEnabled: boolean }> = [];

  const manager = new RemoteControlHostManager({
    isHostSupported: () => true,
    getScreenStream: (mediaId) =>
      mediaId === 'screen-1' ? { sessionId: 'sess-1', cursorCaptured: true } : null,
    sendToPeer: (peerId, packet) => sent.push({ peerId, packet }),
    setMonitorActive: () => {},
    applyInput: async (_controllerId, _sessionId, event) => {
      applied.push(event);
      return { accepted: true, hostBusy: false };
    },
    releaseInputs: (controllerId) => released.push(controllerId),
    syncNativePeer: (peerId, _mediaId, _sessionId, authorized, _mouse, _kbd, gamepadEnabled) => {
      nativeSyncs.push({ peerId, authorized, gamepadEnabled });
    },
    disconnectControllerGamepads: (controllerId) => disconnectedPads.push(controllerId),
    onChange: () => {},
  });

  manager.receiveClientPacket({ type: 'request', mediaId: 'screen-1' }, 'peer-a');
  manager.answerRequest('peer-a:screen-1', true);
  assert.equal(nativeSyncs.at(-1)?.authorized, true);
  assert.equal(nativeSyncs.at(-1)?.gamepadEnabled, true);

  manager.setHostPriorityState(true, 'default', true);
  assert.equal(manager.isElevationBlocked(), true);
  const latestState = sent.filter((entry) => entry.packet.type === 'state').at(-1);
  assert.ok(latestState && latestState.packet.type === 'state');
  assert.equal(latestState.packet.elevationBlocked, true);
  assert.equal(latestState.packet.gamepadEnabled, true);

  manager.receiveClientPacket(
    {
      type: 'input',
      mediaId: 'screen-1',
      event: {
        kind: 'gamepadState',
        padIndex: 0,
        buttons: 0x1000,
        leftTrigger: 0,
        rightTrigger: 0,
        thumbLx: 0,
        thumbLy: 0,
        thumbRx: 0,
        thumbRy: 0,
      },
    },
    'peer-a',
  );
  await Promise.resolve();
  assert.equal(applied.length, 1);
  assert.equal(applied[0].kind, 'gamepadState');

  // Disabling gamepad permission blocks subsequent gamepadState, syncs native peer, and unplugs pads
  manager.setControllerPermissions('peer-a', 'screen-1', { gamepadEnabled: false });
  assert.equal(disconnectedPads.includes('peer-a:screen-1'), true);
  assert.equal(nativeSyncs.at(-1)?.gamepadEnabled, false);
  manager.receiveClientPacket(
    {
      type: 'input',
      mediaId: 'screen-1',
      event: {
        kind: 'gamepadState',
        padIndex: 0,
        buttons: 0x2000,
        leftTrigger: 0,
        rightTrigger: 0,
        thumbLx: 0,
        thumbLy: 0,
        thumbRx: 0,
        thumbRy: 0,
      },
    },
    'peer-a',
  );
  await Promise.resolve();
  assert.equal(applied.length, 1);

  manager.receiveClientPacket({ type: 'release', mediaId: 'screen-1' }, 'peer-a');
  assert.equal(manager.getControllers().length, 0);
  assert.equal(nativeSyncs.at(-1)?.authorized, false);
  assert.equal(released.includes('peer-a:screen-1'), true);
});
