import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileYouTubePlayer, sampleYouTubeLive, type YouTubePlayer, type YouTubePlaybackTracker } from '../../src/apps/youtube_player.ts';
import { markCurrentYouTubeLive, projectYouTubePosition } from '../../src/apps/youtube_timeline.ts';
import { validYouTubeState } from '../../src/apps/models.ts';
import { validYouTubePipCommand } from '../../src/apps/youtube_pip.ts';
import type { YouTubeState } from '../../src/apps/types.ts';

const initial: YouTubeState = { queue: [{ videoId: 'aaaaaaaaaaa', title: 'Broadcast' }],
  index: 0, playing: true, position: 0, repeat: 'off', shuffle: false,
  removePlayed: false, updatedAt: 1, syncReason: 'playback' };

function fixture() {
  const calls: Array<[string, number | undefined]> = [];
  const values = { id: 'aaaaaaaaaaa', duration: 7200, position: 7195, state: 1 };
  const player = {
    getVideoData: () => ({ video_id: values.id }), getDuration: () => values.duration,
    getCurrentTime: () => values.position, getPlayerState: () => values.state,
    loadVideoById: (_id: string, start?: number) => calls.push(['load', start]),
    cueVideoById: (_id: string, start?: number) => calls.push(['cue', start]),
    seekTo: (seconds: number) => calls.push(['seek', seconds]),
    playVideo: () => calls.push(['play', undefined]), pauseVideo: () => calls.push(['pause', undefined]),
  } as unknown as YouTubePlayer;
  const tracker: YouTubePlaybackTracker = { videoId: '', lastLoadAt: 0, lastPlayAttemptAt: 0, lastCorrectionAt: 0 };
  return { player, tracker, values, calls };
}

test('a newly loaded broadcast starts at the default edge and never rewinds on buffering recovery', () => {
  const { player, tracker, values, calls } = fixture();
  reconcileYouTubePlayer(player, initial, tracker, 10_000, 10_000, 'urgent');
  reconcileYouTubePlayer(player, initial, tracker, 10_000, 10_100, 'resume');
  reconcileYouTubePlayer(player, initial, tracker, 10_000, 10_600, 'resume');
  values.duration++;
  values.position++;
  reconcileYouTubePlayer(player, initial, tracker, 10_000, 11_100, 'resume');
  assert.equal(tracker.live, true);
  for (let step = 2; step < 20; step++) {
    values.duration++;
    values.position++;
    values.state = 3;
    reconcileYouTubePlayer(player, initial, tracker, 10_000, 10_000 + step * 1000, 'update');
    values.state = 1;
    reconcileYouTubePlayer(player, initial, tracker, 10_000, 10_100 + step * 1000, 'resume');
    reconcileYouTubePlayer(player, { ...initial, updatedAt: step, position: 20, syncReason: 'heartbeat' },
      tracker, 10_000 + step * 1000, 10_200 + step * 1000, 'periodic');
  }
  assert.deepEqual(calls, [['load', undefined]]);
});

test('live manual seeking waits for buffering and runs only once even if DVR clamps the result', () => {
  const { player, tracker, values, calls } = fixture();
  const live = markCurrentYouTubeLive(initial, true);
  reconcileYouTubePlayer(player, live, tracker, 10_000, 10_000, 'urgent');
  const seek = { ...live, position: 7193, updatedAt: 2, syncReason: 'seek' as const };
  values.state = 3;
  reconcileYouTubePlayer(player, seek, tracker, 11_000, 11_000, 'urgent');
  values.state = 1;
  reconcileYouTubePlayer(player, seek, tracker, 11_000, 11_000, 'resume');
  // The iframe remains at the nearest available DVR keyframe.
  reconcileYouTubePlayer(player, seek, tracker, 11_000, 11_500, 'resume');
  reconcileYouTubePlayer(player, seek, tracker, 11_000, 21_000, 'periodic');
  assert.deepEqual(calls, [['load', undefined], ['seek', 7193]]);
});

test('live pause and play change playback without seeking to a stale room sample', () => {
  const { player, tracker, values, calls } = fixture();
  const live = markCurrentYouTubeLive(initial, true);
  reconcileYouTubePlayer(player, live, tracker, 10_000, 10_000, 'urgent');
  reconcileYouTubePlayer(player, { ...live, playing: false, position: 1, updatedAt: 2 }, tracker, 11_000, 11_000, 'urgent');
  values.state = 2;
  reconcileYouTubePlayer(player, { ...live, position: 1, updatedAt: 3 }, tracker, 12_000, 12_000, 'urgent');
  assert.deepEqual(calls, [['load', undefined], ['pause', undefined], ['play', undefined]]);
});

test('a new live player honors an explicit DVR seek instead of discarding it at load', () => {
  const { player, tracker, calls } = fixture();
  const seek = markCurrentYouTubeLive({ ...initial, position: 7100, syncReason: 'seek' }, true);
  reconcileYouTubePlayer(player, seek, tracker, 10_000, 10_000, 'urgent');
  reconcileYouTubePlayer(player, seek, tracker, 10_000, 10_500, 'resume');
  assert.deepEqual(calls, [['load', 7100]]);
});

test('fixed video durations do not identify a live and changing videos resets detection', () => {
  const { player, tracker, values } = fixture();
  tracker.videoId = values.id;
  assert.equal(sampleYouTubeLive(player, tracker, 10_000), false);
  assert.equal(sampleYouTubeLive(player, tracker, 11_000), false);
  values.duration++;
  assert.equal(sampleYouTubeLive(player, tracker, 12_000), true);
  values.id = 'bbbbbbbbbbb';
  reconcileYouTubePlayer(player, { ...initial, queue: [{ videoId: values.id, title: 'Recording' }], position: 30 },
    tracker, 13_000, 13_000, 'urgent');
  assert.equal(tracker.live, false);
  assert.equal(sampleYouTubeLive(player, tracker, 13_100), false);
  assert.equal(sampleYouTubeLive(player, tracker, 14_100), false);
});

test('broadcast positions beyond one day stay valid in room state, PiP and timeline projection', () => {
  const state = markCurrentYouTubeLive({ ...initial, position: 172800 }, true);
  assert.equal(validYouTubeState(state), true);
  assert.equal(validYouTubePipCommand({ action: 'seek', position: state.position }), true);
  assert.equal(projectYouTubePosition(state.position, true, 10_000, 15_000), 172805);
  assert.equal(state.queue[0].isLive, true);
  assert.equal(initial.queue[0].isLive, undefined);
});
