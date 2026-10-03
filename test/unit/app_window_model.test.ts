import assert from 'node:assert/strict';
import test from 'node:test';
import { RoomAppsService } from '../../src/apps/room_apps_service.ts';
import { NotepadModel, YouTubeModel } from '../../src/apps/models.ts';

function detachedFixture(kind: string) {
  const main = new RoomAppsService();
  const external = new RoomAppsService();
  const remote = new RoomAppsService();
  main.attach((event) => remote.receive(event, 'alice'), 'alice');
  remote.attach((event) => main.receive(event, 'bob'), 'bob');
  const id = main.start(kind);
  main.join(id);
  external.attach((event) => {
    if (event.kind === 'data') main.publishLocalView(id, event.payload);
  }, 'alice');
  external.receive({ kind: 'sync', instances: [main.getInstance(id)!], snapshots: {}, closed: [] }, 'alice');
  const mirror = () => {
    const model = main.getModel(id)!;
    external.applyLocalView(id, model.snapshot(), main.getParticipants(id),
      model instanceof YouTubeModel ? model.receivedAt : undefined);
  };
  mirror();
  const unsubscribe = main.subscribe(mirror);
  return { main, external, remote, id, destroy: () => {
    unsubscribe(); external.reset(); main.reset(); remote.reset();
  } };
}

test('detached notes send edits through the main room and receive remote edits', () => {
  const fixture = detachedFixture('notepad');
  const { main, external, remote, id } = fixture;
  try {
    external.getModel<NotepadModel>(id)!.text.insert(0, 'External');
    assert.equal(main.getModel<NotepadModel>(id)!.text.toString(), 'External');
    assert.equal(remote.getModel<NotepadModel>(id)!.text.toString(), 'External');
    remote.getModel<NotepadModel>(id)!.text.insert(8, ' + remote');
    assert.equal(external.getModel<NotepadModel>(id)!.text.toString(), 'External + remote');
    main.leave(id);
    external.getModel<NotepadModel>(id)!.text.insert(0, 'Ignored');
    assert.equal(main.getModel<NotepadModel>(id)!.text.toString(), 'External + remote');
  } finally { fixture.destroy(); }
});

test('detached YouTube retains the playback receipt clock and publishes under the room actor', () => {
  const fixture = detachedFixture('youtube');
  const { main, external, remote, id } = fixture;
  try {
    const owner = main.getModel<YouTubeModel>(id)!;
    const view = external.getModel<YouTubeModel>(id)!;
    owner.update({ ...owner.state, queue: [{ videoId: 'dQw4w9WgXcQ', title: 'Example' }],
      position: 42, playing: true, updatedAt: Date.now() });
    assert.equal(view.receivedAt, owner.receivedAt);
    assert.deepEqual(view.state, owner.state);
    view.update({ ...view.state, playing: false, syncReason: 'playback' });
    assert.equal(owner.state.playing, false);
    assert.equal(remote.getModel<YouTubeModel>(id)!.state.playing, false);
    assert.equal(owner.actor, 'alice');
    assert.deepEqual(external.getParticipants(id), main.getParticipants(id));
    remote.getModel<YouTubeModel>(id)!.update({ ...owner.state, position: 15, syncReason: 'seek' });
    assert.equal(view.state.position, 15);
  } finally { fixture.destroy(); }
});
