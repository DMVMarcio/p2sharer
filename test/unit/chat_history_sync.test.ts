import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeChatHistory } from '../../src/core/chat_history.ts';
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
  const manager = new GroupRoomManager('Márcio', 'history-test', '', false);
  try {
    await manager.join({
      onStreamsUpdate: () => {}, onSlotsUpdate: () => {}, onPeersUpdate: () => {},
      onStatusChange: () => {}, onChat: (msg) => local.push(msg),
      onChatHistory: (history) => histories.push(history),
    });
    assert.equal(local[0].text, 'Márcio entrou');
    assert.equal(local[0].systemActor, 'Márcio');
    room.onPeerJoin('host');
    const exchanges = sent.filter(({ action, options }) => action === 'history_sync' && options?.target === 'host');
    assert.ok(exchanges.some(({ data }) => data.request === true));
    assert.ok(exchanges.some(({ data }) => data.history?.some((item: ChatMessage) => item.id === local[0].id)));

    const historyHandler = actions.get('history_sync')!.onMessage!;
    const older = message('host-join', local[0].timestamp - 1000, 'Robert entrou');
    historyHandler({ history: [older, local[0]] }, { peerId: 'host' });
    historyHandler({ history: [older, local[0]] }, { peerId: 'host' });
    assert.equal(histories.length, 1);
    assert.deepEqual(histories[0].map((item) => item.id), [older.id, local[0].id]);

    const sentMessage = manager.sendChatMessage('**first**');
    assert.ok(sentMessage.authorId);
    assert.equal(manager.editChatMessage(sentMessage.id, '*changed*'), true);
    assert.equal(local.at(-1)?.text, '*changed*');
    assert.equal(local.at(-1)?.revision, 1);
    const reply = manager.sendChatMessage('answer', sentMessage.id);
    assert.deepEqual(reply.replyTo, { id: sentMessage.id, sender: sentMessage.sender, text: '*changed*' });
    assert.equal(manager.deleteChatMessage(sentMessage.id), true);
    assert.equal(local.at(-1)?.deletedAt !== undefined, true);
    assert.equal(manager.editChatMessage(sentMessage.id, 'revive'), false);
    assert.equal(manager.deleteChatMessage(sentMessage.id), false);

    const remote: ChatMessage = { id: 'remote', timestamp: Date.now(), sender: 'Remote', authorId: 'remote-id', text: 'first', revision: 0 };
    const chatHandler = actions.get('chat')!.onMessage!;
    chatHandler(remote, { peerId: 'host' });
    chatHandler({ ...remote, text: 'second', revision: 1, editedAt: Date.now() }, { peerId: 'host' });
    assert.equal(local.at(-1)?.text, 'second');
    assert.equal(manager.deleteChatMessage(remote.id), false);
  } finally {
    await manager.leave();
    (signalingManager as any).joinRoom = originalJoin;
    (signalingManager as any).leaveRoom = originalLeave;
    (signalingManager as any).reannounce = originalReannounce;
  }
});
