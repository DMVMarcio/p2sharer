import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileYouTubePlayer, type YouTubePlaybackTracker, type YouTubePlayer } from '../../src/apps/youtube_player.ts';
import type { YouTubeState } from '../../src/apps/types.ts';

const state: YouTubeState = {
  queue: [{ videoId: 'aaaaaaaaaaa', title: 'First' }, { videoId: 'bbbbbbbbbbb', title: 'Second' }],
  index: 1, playing: true, position: 0, repeat: 'off', shuffle: false,
  removePlayed: false, updatedAt: 1,
};

test('a transient pause from the old video cannot interrupt the next video', () => {
  const calls: string[] = [];
  let actualId = 'aaaaaaaaaaa';
  let playerState = 2;
  const player = {
    getVideoData: () => ({ video_id: actualId }), getPlayerState: () => playerState,
    getCurrentTime: () => 0,
    loadVideoById: (id: string) => calls.push(`load:${id}`),
    cueVideoById: (id: string) => calls.push(`cue:${id}`),
    playVideo: () => calls.push('play'), pauseVideo: () => calls.push('pause'),
    seekTo: () => calls.push('seek'),
  } as unknown as YouTubePlayer;
  const tracker: YouTubePlaybackTracker = { videoId: 'aaaaaaaaaaa', lastLoadAt: 0,
    lastPlayAttemptAt: 0, lastCorrectionAt: 0 };

  reconcileYouTubePlayer(player, state, tracker, 10_000, 10_000, 'urgent');
  reconcileYouTubePlayer(player, state, tracker, 10_000, 11_000, 'update');
  assert.deepEqual(calls, ['load:bbbbbbbbbbb']);

  reconcileYouTubePlayer(player, state, tracker, 10_000, 12_600, 'update');
  assert.deepEqual(calls, ['load:bbbbbbbbbbb', 'load:bbbbbbbbbbb']);

  actualId = 'bbbbbbbbbbb';
  playerState = 5;
  reconcileYouTubePlayer(player, state, tracker, 10_000, 12_700, 'resume');
  assert.deepEqual(calls, ['load:bbbbbbbbbbb', 'load:bbbbbbbbbbb', 'play']);
});

test('room pause still stops the matching video', () => {
  const calls: string[] = [];
  const player = {
    getVideoData: () => ({ video_id: 'bbbbbbbbbbb' }), getPlayerState: () => 1,
    getCurrentTime: () => 4, pauseVideo: () => calls.push('pause'),
    seekTo: () => calls.push('seek'),
  } as unknown as YouTubePlayer;
  const tracker: YouTubePlaybackTracker = { videoId: 'bbbbbbbbbbb', lastLoadAt: 0,
    lastPlayAttemptAt: 0, lastCorrectionAt: 0 };
  reconcileYouTubePlayer(player, { ...state, playing: false, position: 4 }, tracker, 10_000, 10_000, 'urgent');
  assert.deepEqual(calls, ['pause']);
});

test('repeating the same video seeks to its start even during the correction cooldown', () => {
  const calls: string[] = [];
  const player = {
    getVideoData: () => ({ video_id: 'bbbbbbbbbbb' }), getPlayerState: () => 0,
    getCurrentTime: () => 120, seekTo: (seconds: number) => calls.push(`seek:${seconds}`),
    playVideo: () => calls.push('play'),
  } as unknown as YouTubePlayer;
  const tracker: YouTubePlaybackTracker = { videoId: 'bbbbbbbbbbb', lastLoadAt: 9_000,
    lastPlayAttemptAt: 9_000, lastCorrectionAt: 9_000 };
  reconcileYouTubePlayer(player, state, tracker, 10_000, 10_000, 'urgent');
  assert.deepEqual(calls, ['seek:0', 'play']);
});
