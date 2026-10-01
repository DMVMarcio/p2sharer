import assert from 'node:assert/strict';
import test from 'node:test';
import { YouTubeModel, validYouTubeState } from '../../src/apps/models.ts';
import { appendYouTubeQueue, advanceYouTubeQueue, importYouTubeQueue, moveYouTubeQueueEntry } from '../../src/apps/youtube_queue.ts';
import { describeAutomaticYouTubeActivity, describeYouTubeActivity } from '../../src/apps/youtube_activity.ts';
import { reconcileYouTubePlayer, type YouTubePlayer, type YouTubePlaybackTracker } from '../../src/apps/youtube_player.ts';
import type { YouTubeState } from '../../src/apps/types.ts';

const entries = [{ videoId: 'aaaaaaaaaaa', title: 'First' }, { videoId: 'bbbbbbbbbbb', title: 'Second' }];
const initial: YouTubeState = { queue: entries, index: 0, playing: true, position: 40,
  repeat: 'off', shuffle: false, removePlayed: false, updatedAt: 1, syncReason: 'seek' };

test('metadata publication carries elapsed time forward instead of rewinding the player between heartbeats', (context) => {
  let now = 10_000;
  context.mock.method(Date, 'now', () => now);
  const receiver = new YouTubeModel({ localActor: 'bob', emit: () => {}, changed: () => {} });
  const sender = new YouTubeModel({ localActor: 'alice', emit: (packet) => receiver.apply(packet, 'alice', false), changed: () => {} });
  sender.update(initial);
  const calls: string[] = [];
  const player = { getVideoData: () => ({ video_id: entries[0].videoId }), getPlayerState: () => 1,
    getCurrentTime: () => 40 + (now - 10_000) / 1000, seekTo: () => calls.push('seek'),
    playVideo: () => calls.push('play'), pauseVideo: () => calls.push('pause') } as unknown as YouTubePlayer;
  const tracker: YouTubePlaybackTracker = { videoId: entries[0].videoId, lastLoadAt: 0,
    lastCorrectionAt: 0, lastPlayAttemptAt: 0 };
  const mutations = [
    (state: YouTubeState) => ({ ...state, repeat: 'all' as const }),
    (state: YouTubeState) => ({ ...state, shuffle: true }),
    (state: YouTubeState) => ({ ...state, removePlayed: true }),
    (state: YouTubeState) => appendYouTubeQueue(state, [entries[1]]),
    (state: YouTubeState) => moveYouTubeQueueEntry(state, 0, 1),
    (state: YouTubeState) => importYouTubeQueue(state, entries, 'append', 'alice', 'Alice'),
  ];
  for (const mutate of mutations) {
    now += 5_000;
    sender.update({ ...mutate(sender.state), updatedAt: now, syncReason: 'update' });
    assert.equal(sender.state.position, player.getCurrentTime());
    assert.equal(receiver.state.position, sender.state.position);
    reconcileYouTubePlayer(player, receiver.state, tracker, receiver.receivedAt, now, 'update');
    // The next periodic sync must also see the carried-forward clock, not undo the fix.
    now += 1_000;
    reconcileYouTubePlayer(player, receiver.state, tracker, receiver.receivedAt, now, 'periodic');
  }
  assert.deepEqual(calls, []);
});

test('metadata changes do not seek a matching player, but real synchronization can still correct drift', () => {
  const seeks: number[] = [];
  const player = { getVideoData: () => ({ video_id: entries[0].videoId }), getPlayerState: () => 1,
    getCurrentTime: () => 45, seekTo: (position: number) => seeks.push(position) } as unknown as YouTubePlayer;
  const tracker: YouTubePlaybackTracker = { videoId: entries[0].videoId, lastLoadAt: 0, lastCorrectionAt: 0, lastPlayAttemptAt: 0 };
  reconcileYouTubePlayer(player, { ...initial, shuffle: true, syncReason: 'update' }, tracker, 20_000, 20_000, 'update');
  assert.deepEqual(seeks, []);
  reconcileYouTubePlayer(player, { ...initial, syncReason: 'heartbeat' }, tracker, 20_000, 20_000, 'periodic');
  assert.deepEqual(seeks, [40]);
});

test('automatic advance, repeat, and completion never generate participant-attributed notices', () => {
  const advanced = { ...advanceYouTubeQueue(initial), syncReason: 'auto-advance' as const };
  assert.equal(describeYouTubeActivity(initial, advanced), null);
  assert.equal(describeAutomaticYouTubeActivity(initial, advanced), 'Reprodução automática: “Second”.');
  const repeating = { ...initial, repeat: 'one' as const };
  const repeated = { ...advanceYouTubeQueue(repeating), syncReason: 'auto-advance' as const };
  assert.equal(describeAutomaticYouTubeActivity(repeating, repeated), 'Repetindo automaticamente “First”.');
  assert.equal(describeYouTubeActivity(repeating, repeated), null);
  const ended = { ...advanceYouTubeQueue({ ...initial, index: 1, position: 120 }), syncReason: 'auto-advance' as const };
  assert.equal(ended.position, 120);
  assert.equal(ended.ended, true);
  assert.equal(ended.playing, false);
  assert.equal(validYouTubeState(ended), true);
  assert.equal(describeAutomaticYouTubeActivity(initial, ended), 'Fila de reprodução concluída.');
  assert.equal(describeYouTubeActivity(initial, ended), null);
  const manual = { ...advanceYouTubeQueue(initial, true), syncReason: 'seek' as const };
  assert.equal(describeAutomaticYouTubeActivity(initial, manual), null);
  assert.equal(describeYouTubeActivity(initial, manual), 'reproduziu “Second”');
});

test('additions after the last video ended start the first new entry, including saved queue append', () => {
  const ended = advanceYouTubeQueue({ ...initial, index: 1, position: 120 });
  const added = appendYouTubeQueue(ended, entries);
  assert.equal(added.index, 2);
  assert.equal(added.queue.length, 4);
  assert.equal(added.playing, true);
  assert.equal(added.ended, false);
  assert.equal(added.position, 0);
  const imported = importYouTubeQueue(ended, entries, 'append', 'alice', 'Alice');
  assert.equal(imported.index, 2);
  assert.equal(imported.playing, true);
  assert.equal(imported.queue[2].addedBy, 'alice');
  for (const state of [initial, { ...initial, playing: false }]) {
    const appended = appendYouTubeQueue(state, entries);
    assert.equal(appended.index, state.index);
    assert.equal(appended.playing, state.playing);
    assert.equal(appended.position, state.position);
  }
});

test('finished playback is not sought back to zero and remove-played starts cleanly on a later addition', () => {
  const calls: string[] = [];
  const ended = { ...advanceYouTubeQueue({ ...initial, index: 1, position: 120 }), syncReason: 'auto-advance' as const };
  const player = { getVideoData: () => ({ video_id: entries[1].videoId }), getPlayerState: () => 0,
    getCurrentTime: () => 120, seekTo: () => calls.push('seek'), pauseVideo: () => calls.push('pause'),
    playVideo: () => calls.push('play') } as unknown as YouTubePlayer;
  const tracker: YouTubePlaybackTracker = { videoId: entries[1].videoId, lastLoadAt: 0, lastCorrectionAt: 0, lastPlayAttemptAt: 0 };
  reconcileYouTubePlayer(player, ended, tracker, 20_000, 20_000, 'urgent');
  assert.deepEqual(calls, ['pause']);
  const empty = advanceYouTubeQueue({ ...initial, queue: [entries[0]], removePlayed: true });
  assert.equal(empty.queue.length, 0);
  assert.equal(appendYouTubeQueue(empty, entries).playing, true);
  assert.equal(validYouTubeState({ ...initial, ended: true }), false);
  assert.equal(validYouTubeState({ ...initial, ended: 'yes' }), false);
});
