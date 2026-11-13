import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createIdleViewerState,
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
