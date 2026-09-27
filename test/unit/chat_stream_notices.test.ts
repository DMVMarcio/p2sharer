import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '../../src/core/types.ts';
import { GroupRoomManager } from '../../src/p2p/group_room.ts';
import { signalingManager } from '../../src/p2p/signaling_manager.ts';

test('stream owner publishes one start and stop notice into synchronized history', async () => {
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
    getPeers: () => ({}), addStream: async () => {}, removeStream: () => {}, leave: async () => {},
    onPeerJoin: (_peerId: string) => {}, onPeerLeave: (_peerId: string) => {},
    onPeerStream: (_stream: MediaStream, _peerId: string) => {},
  };
  (signalingManager as any).joinRoom = () => room;
  (signalingManager as any).leaveRoom = async () => {};
  (signalingManager as any).reannounce = async () => {};
  const received: ChatMessage[] = [];
  const manager = new GroupRoomManager('Márcio', 'stream-notices-test', '', true);
  const track = { id: 'video-track', kind: 'video', stop: () => {} };
  const stream = {
    id: 'stream-1', getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [],
  } as unknown as MediaStream;
  try {
    await manager.join({
      onStreamsUpdate: () => {}, onSlotsUpdate: () => {}, onPeersUpdate: () => {},
      onStatusChange: () => {}, onChat: (message) => received.push(message),
      onChatHistory: () => {},
    });
    manager.shareStream(stream);
    manager.shareStream(stream);
    const remoteStatus = actions.get('stream_status')!.onMessage!;
    remoteStatus({ isStreaming: true, senderName: 'Robert' }, { peerId: 'other-peer' });
    remoteStatus({ isStreaming: true, senderName: 'Robert' }, { peerId: 'other-peer' });
    manager.stopStream();
    manager.stopStream();

    const notices = received.filter((message) => message.systemType?.startsWith('stream-'));
    assert.deepEqual(notices.map((message) => message.text), [
      'Márcio iniciou uma transmissão', 'Márcio parou de transmitir',
    ]);
    assert.ok(notices.every((message) => message.systemActor === 'Márcio'));
    assert.equal(sent.filter(({ action, data }) => action === 'chat' &&
      data.systemType?.startsWith('stream-')).length, 2);

    room.onPeerJoin('late-peer');
    const history = sent.findLast(({ action, data, options }) => action === 'history_sync' &&
      options?.target === 'late-peer' && Array.isArray(data.history))?.data.history as ChatMessage[];
    assert.deepEqual(history.filter((message) => message.systemType?.startsWith('stream-'))
      .map((message) => message.id), notices.map((message) => message.id));
  } finally {
    await manager.leave();
    (signalingManager as any).joinRoom = originalJoin;
    (signalingManager as any).leaveRoom = originalLeave;
    (signalingManager as any).reannounce = originalReannounce;
  }
});
