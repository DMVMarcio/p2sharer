import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoomService } from '../../src/services/room_service.ts';
import { GroupRoomManager, type RoomCallbacks } from '../../src/p2p/group_room.ts';
import { createAuthenticatedInvite } from '../../src/core/room_invite.ts';
import { stateStore } from '../../src/core/state_store.ts';
import { modalManager } from '../../src/hooks/useModal.ts';
import { setupTestDOM } from '../helpers/browser_mocks.ts';
import { soundEffects } from '../../src/ui/sound_effects.ts';

test('an unanswered room opens locally without granting admission and resumes its password dialog on denial', async () => {
  const dom = setupTestDOM();
  const originalJoin = GroupRoomManager.prototype.join;
  const originalSound = soundEffects.playUserJoin;
  soundEffects.playUserJoin = () => {};
  const service = new RoomService();
  const created = await createAuthenticatedInvite();
  let callbacks: RoomCallbacks | undefined;
  GroupRoomManager.prototype.join = async function (listeners) {
    callbacks = listeners;
    listeners.onStatusChange('Procurando Participantes...');
  };
  try {
    await service.joinRoom(created.invite, 'wrong-fixture', false, { waitForAdmission: false });
    assert.equal(service.joinOutcome, 'waiting');
    assert.equal(service.connectingOverlay.visible, false);
    assert.equal(service.roomManager?.hasAdmission(), false, 'local readiness must not authorize room content');
    assert.equal(stateStore.roomSlots.length, 1);
    callbacks!.onStatusChange('Senha incorreta para esta sala');
    assert.equal(service.joinOutcome, 'error');
    assert.equal(modalManager.getActive(), 'joinRoom');
    assert.equal(service.pendingJoinInvite, created.invite);
    assert.equal(service.pendingJoinPassword, 'wrong-fixture');
    assert.equal(service.pendingJoinError, 'Senha incorreta para esta sala');
    assert.equal(service.joinDialogRevision, 1);
  } finally {
    service.hideConnecting();
    service.roomManager = null;
    stateStore.set(state => { state.roomSlots = []; state.currentRoomInvite = ''; });
    modalManager.open(null);
    GroupRoomManager.prototype.join = originalJoin;
    soundEffects.playUserJoin = originalSound;
    dom.cleanup();
  }
});

test('a room setup failure cannot be reported as local waiting readiness', async () => {
  const dom = setupTestDOM();
  const originalJoin = GroupRoomManager.prototype.join;
  const originalSound = soundEffects.playUserJoin;
  soundEffects.playUserJoin = () => {};
  const service = new RoomService();
  const created = await createAuthenticatedInvite();
  GroupRoomManager.prototype.join = async function (listeners) {
    listeners.onStatusChange('Erro ao conectar na sala');
  };
  try {
    await service.joinRoom(created.invite, '', false, { waitForAdmission: false });
    assert.equal(service.joinOutcome, 'error');
    assert.equal(service.roomManager?.hasAdmission(), false);
  } finally {
    service.hideConnecting(); service.roomManager = null;
    stateStore.set(state => { state.roomSlots = []; state.currentRoomInvite = ''; });
    GroupRoomManager.prototype.join = originalJoin;
    soundEffects.playUserJoin = originalSound;
    dom.cleanup();
  }
});

test('cancelled discovery finishes cleanup before another preview and admission adopts that connection', async () => {
  const dom = setupTestDOM();
  const service = new RoomService();
  const created = await createAuthenticatedInvite();
  const first = new GroupRoomManager('Viewer', created.invite, '', false);
  const next = new GroupRoomManager('Viewer', created.invite, '', false);
  const original = { join: GroupRoomManager.prototype.join, leave: GroupRoomManager.prototype.leave,
    sound: soundEffects.playUserJoin };
  soundEffects.playUserJoin = () => {};
  const calls: string[] = [];
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  GroupRoomManager.prototype.join = async function (callbacks, previewOnly, password) {
    if (this === first) { calls.push('first-start'); await ready; calls.push('first-ready'); }
    else calls.push(previewOnly ? 'next-preview' : `next-admit:${password}`);
    callbacks.onStatusChange('Procurando Participantes...');
  };
  GroupRoomManager.prototype.leave = async function () { calls.push(this === first ? 'first-left' : 'next-left'); };
  const callbacks: RoomCallbacks = { onStreamsUpdate: () => {}, onSlotsUpdate: () => {}, onChat: () => {},
    onChatHistory: () => {}, onPeersUpdate: () => {}, onStatusChange: () => {} };
  const cancelled = new AbortController();
  const active = new AbortController();
  try {
    const initial = service.startRoomPreview(first, callbacks, cancelled.signal);
    await Promise.resolve();
    cancelled.abort();
    const cleanup = service.stopRoomPreview(first);
    const fresh = service.startRoomPreview(next, callbacks, active.signal);
    assert.deepEqual(calls, ['first-start']);
    finish();
    await Promise.all([initial, cleanup, fresh]);
    assert.deepEqual(calls, ['first-start', 'first-ready', 'first-left', 'next-preview']);
    await service.joinRoom(created.invite, 'fixture-password', false,
      { preview: next, signal: active.signal, waitForAdmission: false });
    assert.equal(service.roomManager, next);
    assert.equal(service.joinOutcome, 'waiting');
    assert.equal(calls.at(-1), 'next-admit:fixture-password');
    assert.equal(calls.includes('next-left'), false, 'promotion must not tear down the healthy discovery transport');
  } finally {
    service.hideConnecting(); service.roomManager = null;
    stateStore.set(state => { state.roomSlots = []; state.currentRoomInvite = ''; });
    GroupRoomManager.prototype.join = original.join;
    GroupRoomManager.prototype.leave = original.leave;
    soundEffects.playUserJoin = original.sound;
    dom.cleanup();
  }
});
