import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeChatHistory } from '../../src/core/chat_history.ts';
import { PeerAuthenticator } from '../../src/core/peer_auth.ts';
import type { ChatMessage } from '../../src/core/types.ts';
import { GroupRoomManager } from '../../src/p2p/group_room.ts';
import { signalingManager } from '../../src/p2p/signaling_manager.ts';

const message = (id: string, timestamp: number, text = id): ChatMessage => ({
  id, timestamp, text, sender: 'Sistema', isSystem: true, systemType: 'join',
});

test('history merge orders chat and notices while ignoring repeated IDs', () => {
  const old = message('old-join', 10);
  const own = message('own-join', 30);
  const chat = { ...message('chat', 20), isSystem: false };
  const result = mergeChatHistory([own], [old, chat, own, old]);
  assert.deepEqual(result.map((item) => item.id), ['old-join', 'chat', 'own-join']);
  assert.equal(mergeChatHistory(result, [old]).length, 3);
});

test('history merge keeps the latest authored revision and never revives deleted text', () => {
  const original: ChatMessage = { id: 'message', timestamp: 10, sender: 'Alice', authorId: 'alice', text: '**hello**', revision: 0 };
  const edited: ChatMessage = { ...original, text: '**updated**', revision: 1, editedAt: 11 };
  const deleted: ChatMessage = { ...edited, text: '', revision: 2, deletedAt: 12 };
  assert.equal(mergeChatHistory([original], [edited])[0].text, '**updated**');
  assert.deepEqual(mergeChatHistory([deleted], [original, edited]), [deleted]);
  assert.deepEqual(mergeChatHistory([original], [{ ...edited, authorId: 'intruder' }]), [original]);
});

test('join creates own notice and direct handshake exchanges history both ways', async () => {
  const originalJoin = signalingManager.joinRoom;
  const originalLeave = signalingManager.leaveRoom;
  const originalReannounce = signalingManager.reannounce;
  const actions = new Map<string, { send: (data: any, options?: any) => Promise<void>; onMessage?: (data: any, meta: any) => void }>();
  const sent: Array<{ action: string; data: any; options?: any }> = [];
  const room = {
    makeAction(name: string) {
      const action = { send: async (data: any, options?: any) => { sent.push({ action: name, data, options }); } };
      actions.set(name, action);
      return action;
    },
    getPeers: () => ({}), leave: async () => {},
    onPeerJoin: (_peerId: string) => {}, onPeerLeave: (_peerId: string) => {},
    onPeerStream: (_stream: MediaStream, _peerId: string) => {},
  };
  (signalingManager as any).joinRoom = () => room;
  (signalingManager as any).leaveRoom = async () => {};
  (signalingManager as any).reannounce = async () => {};
  const local: ChatMessage[] = [];
  const histories: ChatMessage[][] = [];
  const passwordChanges: Array<{ password: string; actor: string }> = [];
  const watchStarts: Array<{ id: string; name: string }> = [];
  const streamStarts: Array<{ id: string; name: string }> = [];
  const manager = new GroupRoomManager('Márcio', 'history-test', '', false);
  try {
    await manager.join({
      onStreamsUpdate: () => {}, onSlotsUpdate: () => {}, onPeersUpdate: () => {},
      onStatusChange: () => {}, onChat: (msg) => local.push(msg),
      onChatHistory: (history) => histories.push(history),
      onPasswordChange: (password, actor) => passwordChanges.push({ password, actor }),
      onWatchStarted: (id, name) => watchStarts.push({ id, name }),
      onStreamStarted: (id, name) => streamStarts.push({ id, name }),
    });
    assert.equal(local[0].text, 'Márcio entrou');
    assert.equal(local[0].systemActor, 'Márcio');
    room.onPeerJoin('host');
    const exchanges = sent.filter(({ action, options }) => action === 'history_sync' && options?.target === 'host');
    assert.ok(exchanges.some(({ data }) => data.request === true));
    assert.ok(exchanges.some(({ data }) => data.history?.some((item: ChatMessage) => item.id === local[0].id)));
    actions.get('presence')!.onMessage!({ username: 'Host', isCreator: true, isStreaming: false }, { peerId: 'host' });

    const historyHandler = actions.get('history_sync')!.onMessage!;
    const hostAuth = await PeerAuthenticator.create('history-test', 'host');
    const older = await hostAuth.sign({ ...message('host-join', local[0].timestamp - 1000, 'Host entrou'), authorId: 'host', revision: 0, systemActor: 'Host' });
    await historyHandler({ history: [older, local[0]] }, { peerId: 'host' });
    await historyHandler({ history: [older, local[0]] }, { peerId: 'host' });
    assert.equal(histories.length, 1);
    assert.deepEqual(histories[0].map((item) => item.id), [older.id, local[0].id]);

    const sentMessage = await manager.sendChatMessage('**first**');
    assert.ok(sentMessage.authorId);
    assert.equal(await manager.editChatMessage(sentMessage.id, '*changed*'), true);
    assert.equal(local.at(-1)?.text, '*changed*');
    assert.equal(local.at(-1)?.revision, 1);
    const reply = await manager.sendChatMessage('answer', sentMessage.id);
    assert.deepEqual(reply.replyTo, { id: sentMessage.id, sender: sentMessage.sender, text: '*changed*' });
    assert.equal(await manager.deleteChatMessage(sentMessage.id), true);
    assert.equal(local.at(-1)?.deletedAt !== undefined, true);
    assert.equal(await manager.editChatMessage(sentMessage.id, 'revive'), false);
    assert.equal(await manager.deleteChatMessage(sentMessage.id), false);

    const remote = await hostAuth.sign({ id: 'remote', timestamp: Date.now(), sender: 'Host', authorId: 'host', text: 'first', revision: 0 });
    const chatHandler = actions.get('chat')!.onMessage!;
    await chatHandler(remote, { peerId: 'host' });
    const remoteEdit = await hostAuth.sign({ ...remote, text: 'second', revision: 1, editedAt: Date.now() });
    await chatHandler(remoteEdit, { peerId: 'host' });
    assert.equal(local.at(-1)?.text, 'second');
    assert.equal(await manager.deleteChatMessage(remote.id), false);

    room.onPeerJoin('mallory');
    actions.get('presence')!.onMessage!({ username: 'Mallory', isCreator: false }, { peerId: 'mallory' });
    actions.get('presence')!.onMessage!({ username: 'Mallory', isCreator: true }, { peerId: 'mallory' });
    assert.equal(manager.getConnectedPeers().find((peer) => peer.id === 'mallory')?.isCreator, false);
    const malloryAuth = await PeerAuthenticator.create('history-test', 'mallory');
    const fakeNotice = await malloryAuth.sign({
      id: 'fake-notice', authorId: 'mallory', sender: 'Sistema', text: 'Host saiu',
      timestamp: Date.now(), revision: 0, isSystem: true, systemType: 'leave', systemActor: 'Host',
    });
    await chatHandler(fakeNotice, { peerId: 'mallory' });
    assert.notEqual(local.at(-1)?.id, fakeNotice.id);
    const fabricatedSystem = await malloryAuth.sign({
      ...fakeNotice, id: 'fabricated-system', text: 'Sala encerrada', systemActor: 'Mallory',
    });
    await chatHandler(fabricatedSystem, { peerId: 'mallory' });
    assert.notEqual(local.at(-1)?.id, fabricatedSystem.id);
    const forgedRevision = await malloryAuth.sign({ ...remote, authorId: 'mallory', revision: 99, text: 'forged' });
    await chatHandler({ ...forgedRevision, authorId: 'host' }, { peerId: 'mallory' });
    await historyHandler({ history: [{ ...remoteEdit, text: 'forged' }] }, { peerId: 'mallory' });
    await chatHandler(forgedRevision, { peerId: 'mallory' });
    assert.equal(local.at(-1)?.text, 'second');

    actions.get('peer_leave')!.onMessage!({ peerId: 'host' }, { peerId: 'mallory' });
    actions.get('mesh_relay')!.onMessage!({ target: 'all', origin: 'host', kind: 'peer_leave', payload: {} }, { peerId: 'mallory' });
    assert.ok(manager.getConnectedPeers().some((peer) => peer.id === 'host'));

    actions.get('peer_exchange')!.onMessage!({ peers: [{ peerId: 'host', username: 'Forged Host', isCreator: true, joinedAt: 0 }] }, { peerId: 'mallory' });
    assert.equal(manager.getConnectedPeers().find((peer) => peer.id === 'host')?.username, 'Host');
    assert.equal(manager.getConnectedPeers().find((peer) => peer.id === 'host')?.isCreator, true);

    assert.equal(await manager.updateRoomPassword('unauthorized'), false);
    actions.get('room_password_sync')!.onMessage!({ newPassword: 'forged', updatedBy: 'Host' }, { peerId: 'mallory' });
    actions.get('room_password_sync')!.onMessage!({ newPassword: 'accepted', updatedBy: 'Mallory' }, { peerId: 'host' });
    assert.deepEqual(passwordChanges, [{ password: 'accepted', actor: 'Host' }]);

    actions.get('watch_status')!.onMessage!({ broadcasterId: 'host', isWatching: true, watcherName: 'Host' }, { peerId: 'mallory' });
    assert.deepEqual(watchStarts, [{ id: 'mallory', name: 'Mallory' }]);
    actions.get('stream_status')!.onMessage!({ isStreaming: true, senderName: 'Host' }, { peerId: 'mallory' });
    assert.deepEqual(streamStarts.at(-1), { id: 'mallory', name: 'Mallory' });
  } finally {
    await manager.leave();
    (signalingManager as any).joinRoom = originalJoin;
    (signalingManager as any).leaveRoom = originalLeave;
    (signalingManager as any).reannounce = originalReannounce;
  }
});
