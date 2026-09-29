import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInvidiousPlaylist, parseInvidiousResults, parseYouTubeInput } from '../../src/apps/youtube_api.ts';

test('video and playlist URLs expose both preview candidates without adding either', () => {
  assert.deepEqual(parseYouTubeInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL-SFn27cXc6q0JMNHzVeRkzrVTfTQkMFh'), {
    videoId: 'dQw4w9WgXcQ', playlistId: 'PL-SFn27cXc6q0JMNHzVeRkzrVTfTQkMFh',
  });
  assert.deepEqual(parseYouTubeInput('https://www.youtube.com/live/dQw4w9WgXcQ'),
    { videoId: 'dQw4w9WgXcQ', playlistId: undefined });
});

test('keyless search accepts valid video and playlist records only', () => {
  const results = parseInvidiousResults([
    { type: 'video', videoId: 'dQw4w9WgXcQ', title: '  Example video  ' },
    { type: 'playlist', playlistId: 'PL-SFn27cXc6q0JMNHzVeRkzrVTfTQkMFh', title: 'Example playlist' },
    { type: 'video', videoId: 'bad', title: 'Invalid' },
    { type: 'playlist', playlistId: 'bad', title: 'Invalid' },
    { type: 'channel', authorId: 'test', title: 'Channel' },
  ]);
  assert.deepEqual(results, [
    { kind: 'video', id: 'dQw4w9WgXcQ', title: 'Example video' },
    { kind: 'playlist', id: 'PL-SFn27cXc6q0JMNHzVeRkzrVTfTQkMFh', title: 'Example playlist' },
  ]);
});

test('playlist import rejects invalid entries before they reach shared state', () => {
  assert.deepEqual(parseInvidiousPlaylist({ videos: [
    { videoId: 'dQw4w9WgXcQ', title: 'First' },
    { videoId: 'bad', title: 'Invalid' },
  ] }), [{ videoId: 'dQw4w9WgXcQ', title: 'First' }]);
});
