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
  assert.deepEqual(first.getJoinedInstances(), []);
  assert.deepEqual(second.getParticipants(note), []);
  first.join(note);
  assert.equal(first.isJoined(note), true);
  assert.deepEqual(first.getJoinedInstances().map((instance) => instance.id), [note]);
  assert.deepEqual(second.getJoinedInstances(), []);
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
  assert.deepEqual(first.getJoinedInstances(), []);
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


test('personal apps never publish existence, state, presence, notices, or closed IDs', () => {
  const service = new RoomAppsService();
  const peer = new RoomAppsService();
  const sent: AppWireEvent[] = [];
  const notices: string[] = [];
  service.attach((event) => { sent.push(event); peer.receive(event, 'alice'); }, 'alice',
    (action) => notices.push(action));
  peer.attach(() => {}, 'bob');
  const note = service.start('notepad', true);
  const video = service.start('youtube', true);
  assert.equal(service.isJoined(note), true);
  assert.deepEqual(service.getParticipants(video), ['alice']);
  service.getModel<NotepadModel>(note)!.replace('Personal secret');
  service.getModel<NotepadModel>(note)!.awareness.setLocalState({ user: { name: 'Alice' } });
  const model = service.getModel<YouTubeModel>(video)!;
  model.update({ ...model.state, queue: [{ videoId: 'dQw4w9WgXcQ', title: 'Private video' }] });
  service.publishLocalView(note, service.getModel<NotepadModel>(note)!.snapshot());
  assert.deepEqual(sent, []);
  assert.deepEqual(notices, []);
  const shared = service.start('notepad');
  service.getModel<NotepadModel>(shared)!.replace('Shared note');
  service.sendSync('bob');
  assert.deepEqual(peer.getInstances().map((item) => item.id), [shared]);
  assert.equal(peer.getModel<NotepadModel>(shared)!.text.toString(), 'Shared note');
  assert.ok(!JSON.stringify(sent).includes(note));
  assert.ok(!JSON.stringify(sent).includes(video));
  sent.length = 0;
  service.leave(note);
  service.stop(video);
  assert.equal(service.getInstance(note), undefined);
  assert.deepEqual(sent, []);
  service.sendSync('bob');
  assert.ok(!JSON.stringify(sent).includes(note));
  assert.ok(!JSON.stringify(sent).includes(video));
  service.reset(); peer.reset();
});

test('room packets cannot modify, join, stop, or import personal instances', () => {
  const service = new RoomAppsService();
  service.attach(() => {}, 'alice');
  const id = service.start('notepad', true);
  const model = service.getModel<NotepadModel>(id)!;
  model.replace('Keep private');
  const attacker = new NotepadModel({ localActor: 'bob', emit: () => {}, changed: () => {} });
  attacker.replace('Injected');
  service.receive({ kind: 'data', id, payload: attacker.snapshot() }, 'bob');
  service.receive({ kind: 'presence', id, joined: true }, 'bob');
  service.receive({ kind: 'stop', id }, 'bob');
  service.receive({ kind: 'sync', instances: [], snapshots: { [id]: attacker.snapshot() }, closed: [id] }, 'bob');
  assert.equal(model.text.toString(), 'Keep private');
  assert.equal(service.getInstance(id)?.personal, true);
  assert.deepEqual(service.getParticipants(id), ['alice']);
  const remotePersonal = { ...service.getInstance(id)!, id: crypto.randomUUID(), createdBy: 'bob' };
  service.receive({ kind: 'start', instance: remotePersonal }, 'bob');
  service.receive({ kind: 'sync', instances: [remotePersonal], snapshots: {}, closed: [] }, 'bob');
  assert.equal(service.getInstances().length, 1);
  service.reset(); attacker.destroy();
});

test('personal detached models forward only device-local edits and retain main transport isolation', () => {
  const main = new RoomAppsService();
  const mirror = new RoomAppsService();
  const sent: AppWireEvent[] = [];
  main.attach((event) => sent.push(event), 'alice');
  const id = main.start('notepad', true);
  mirror.attach((event) => {
    if (event.kind === 'data') main.publishLocalView(id, event.payload);
  }, 'alice');
  mirror.initializeLocalView(main.getInstance(id)!);
  mirror.applyLocalView(id, main.getModel(id)!.snapshot(), ['alice']);
  mirror.getModel<NotepadModel>(id)!.replace('From my window');
  assert.equal(main.getModel<NotepadModel>(id)!.text.toString(), 'From my window');
  assert.deepEqual(sent, []);
  main.getModel<NotepadModel>(id)!.text.insert(0, 'Main: ');
  mirror.applyLocalView(id, main.getModel(id)!.snapshot(), ['alice']);
  assert.equal(mirror.getModel<NotepadModel>(id)!.text.toString(), 'Main: From my window');
  mirror.reset(); main.reset();
  assert.deepEqual(sent, []);
});
