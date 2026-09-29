import assert from 'node:assert/strict';
import test from 'node:test';
import { RoomAppsService } from '../../src/apps/room_apps_service.ts';
import { NotepadModel, YouTubeModel } from '../../src/apps/models.ts';
import { registerRoomApp } from '../../src/apps/registry.ts';
import type { AppWireEvent } from '../../src/apps/types.ts';
import * as Y from 'yjs';

test('multiple instances of the same app stay independent and late peers recover state', () => {
  const first = new RoomAppsService();
  const second = new RoomAppsService();
  const third = new RoomAppsService();
  let thirdConnected = false;
  first.attach((event) => {
    second.receive(event, 'alice');
    if (thirdConnected) third.receive(event, 'alice');
  }, 'alice');
  second.attach((event) => first.receive(event, 'bob'), 'bob');
  const a = first.start('notepad');
  const b = first.start('notepad');
  first.getModel<NotepadModel>(a)!.text.insert(0, 'First');
  first.getModel<NotepadModel>(b)!.text.insert(0, 'Second');
  assert.equal(second.getModel<NotepadModel>(a)!.text.toString(), 'First');
  assert.equal(second.getModel<NotepadModel>(b)!.text.toString(), 'Second');
  third.attach(() => {}, 'charlie');
  thirdConnected = true;
  first.sendSync('charlie');
  assert.equal(third.getModel<NotepadModel>(a)!.text.toString(), 'First');
  assert.equal(third.getModel<NotepadModel>(b)!.text.toString(), 'Second');
  assert.equal(third.getInstances().length, 2);
});

test('concurrent note edits merge and forged YouTube updates are rejected', () => {
  const first = new RoomAppsService();
  const second = new RoomAppsService();
  const pending: Array<{ event: AppWireEvent; actor: string }> = [];
  first.attach((event) => pending.push({ event, actor: 'alice' }), 'alice');
  second.attach((event) => pending.push({ event, actor: 'bob' }), 'bob');
  const note = first.start('notepad');
  second.receive(pending.shift()!.event, 'alice');
  first.getModel<NotepadModel>(note)!.text.insert(0, 'A');
  second.getModel<NotepadModel>(note)!.text.insert(0, 'B');
  for (const message of pending.splice(0)) {
    (message.actor === 'alice' ? second : first).receive(message.event, message.actor);
  }
  assert.equal(first.getModel<NotepadModel>(note)!.text.toString(), second.getModel<NotepadModel>(note)!.text.toString());
  assert.equal(first.getModel<NotepadModel>(note)!.text.length, 2);

  const video = first.start('youtube');
  second.receive(pending.shift()!.event, 'alice');
  const state = { queue: [{ videoId: 'dQw4w9WgXcQ', title: 'Example' }], index: 0,
    playing: true, position: 0, repeat: 'off', shuffle: false, removePlayed: false,
    updatedAt: Date.now() };
  second.receive({ kind: 'data', id: video, payload: { state, clock: 10, actor: 'mallory' } }, 'alice');
  assert.equal(second.getModel<YouTubeModel>(video)!.state.queue.length, 0);
  second.receive({ kind: 'data', id: video, payload: { state, clock: 10, actor: 'alice' } }, 'alice');
  assert.equal(second.getModel<YouTubeModel>(video)!.state.queue.length, 1);
  assert.ok(Date.now() - second.getModel<YouTubeModel>(video)!.receivedAt < 1000);
  second.receive({ kind: 'data', id: video, payload: { state: { ...state, queue: [] },
    clock: 9, actor: 'alice' } }, 'alice');
  assert.equal(second.getModel<YouTubeModel>(video)!.state.queue.length, 1);
});

test('a newly registered app uses the existing instance and synchronization protocol', () => {
  registerRoomApp({ kind: 'countertest', label: 'Counter',
    createModel: (context) => {
      let value = 0;
      return {
        get value() { return value; },
        snapshot: () => ({ value }),
        apply: (payload: unknown) => {
          const next = (payload as { value?: unknown })?.value;
          if (Number.isSafeInteger(next) && (next as number) >= 0) {
            value = next as number;
            context.changed();
          }
        },
        destroy: () => {},
      };
    },
    loadView: async () => ({ default: () => null }),
  });
  const first = new RoomAppsService();
  const second = new RoomAppsService();
  first.attach((event) => second.receive(event, 'alice'), 'alice');
  second.attach(() => {}, 'bob');
  const id = first.start('countertest');
  assert.equal(second.getInstance(id)?.kind, 'countertest');
  second.receive({ kind: 'data', id, payload: { value: 7 } }, 'alice');
  assert.equal((second.getModel(id) as { value: number }).value, 7);
});

test('activity presence is opt-in, synced per instance, and cleared on leave or disconnect', () => {
  const first = new RoomAppsService();
  const second = new RoomAppsService();
  const late = new RoomAppsService();
  let lateConnected = false;
  first.attach((event) => {
    second.receive(event, 'alice');
    if (lateConnected) late.receive(event, 'alice');
  }, 'alice');
  second.attach((event) => {
    first.receive(event, 'bob');
    if (lateConnected) late.receive(event, 'bob');
  }, 'bob');
  const note = first.start('notepad');
  assert.equal(first.isJoined(note), false);
  assert.deepEqual(second.getParticipants(note), []);
  first.join(note);
  assert.equal(first.isJoined(note), true);
  assert.deepEqual(second.getParticipants(note), ['alice']);
  second.join(note);
  assert.deepEqual(first.getParticipants(note), ['alice', 'bob']);
  late.attach(() => {}, 'charlie');
  lateConnected = true;
  first.sendSync('charlie');
  assert.deepEqual(late.getParticipants(note), ['alice']);
  second.sendSync('charlie');
  assert.deepEqual(late.getParticipants(note), ['alice', 'bob']);
  first.leave(note);
  assert.deepEqual(late.getParticipants(note), ['bob']);
  late.forgetPeer('bob');
  assert.deepEqual(late.getParticipants(note), []);
});

test('rich note fragments synchronize and survive late-peer snapshots', () => {
  const first = new RoomAppsService();
  const second = new RoomAppsService();
  const late = new RoomAppsService();
  first.attach((event) => second.receive(event, 'alice'), 'alice');
  second.attach((event) => first.receive(event, 'bob'), 'bob');
  const id = first.start('notepad');
  const paragraph = new Y.XmlElement('paragraph');
  const words = new Y.XmlText();
  words.insert(0, 'Shared rich text');
  paragraph.insert(0, [words]);
  first.getModel<NotepadModel>(id)!.richContent.insert(0, [paragraph]);
  assert.equal(second.getModel<NotepadModel>(id)!.richContent.toString(),
    first.getModel<NotepadModel>(id)!.richContent.toString());
  late.attach(() => {}, 'charlie');
  late.receive({ kind: 'sync', instances: [first.getInstance(id)!],
    snapshots: { [id]: first.getModel<NotepadModel>(id)!.snapshot() }, closed: [] }, 'alice');
  assert.equal(late.getModel<NotepadModel>(id)!.richContent.toString(),
    first.getModel<NotepadModel>(id)!.richContent.toString());
});

test('only the local actor emits app lifecycle notices, once per start and stop', () => {
  const first = new RoomAppsService();
  const second = new RoomAppsService();
  const notices: string[] = [];
  first.attach((event) => second.receive(event, 'alice'), 'alice', (action, instance) => {
    notices.push(`${action}:${instance.kind}:${instance.id}`);
  });
  second.attach(() => {}, 'bob', () => { throw new Error('Remote events must not create notices'); });
  const id = first.start('notepad');
  first.stop(id);
  first.stop(id);
  assert.deepEqual(notices, [`start:notepad:${id}`, `stop:notepad:${id}`]);
});
