import assert from 'node:assert/strict';
import test from 'node:test';
import { loadYouTubePlaylist, loadYouTubePlaylistPreview, parseInvidiousPlaylist, parseInvidiousResults, parseYouTubeInput } from '../../src/apps/youtube_api.ts';

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

test('Mix links preview only the selected video across radio variants and YouTube hosts', () => {
  for (const id of ['RDbD6ifecX6rs', 'RDMMbD6ifecX6rs', 'RDAMVMbD6ifecX6rs', 'RDCLAK5uy_example']) {
    for (const base of ['https://www.youtube.com/watch?v=bD6ifecX6rs',
      'https://music.youtube.com/watch?v=bD6ifecX6rs', 'https://youtu.be/bD6ifecX6rs?si=shared']) {
      assert.deepEqual(parseYouTubeInput(`${base}&list=${id}&start_radio=1`), {
        videoId: 'bD6ifecX6rs', playlistId: undefined,
      });
    }
    assert.deepEqual(parseYouTubeInput(`https://www.youtube.com/watch?v=bD6ifecX6rs&list=${id}`), {
      videoId: 'bD6ifecX6rs', playlistId: undefined,
    });
  }
});

test('ordinary playlists remain available even with unrelated radio parameters', () => {
  assert.deepEqual(parseYouTubeInput('https://www.youtube.com/watch?v=bD6ifecX6rs&list=PL-SFn27cXc6q0JMNHzVeRkzrVTfTQkMFh&start_radio=1'), {
    videoId: 'bD6ifecX6rs', playlistId: 'PL-SFn27cXc6q0JMNHzVeRkzrVTfTQkMFh',
  });
});

test('generated Mix playlists are excluded from discovery and never trigger playlist requests', async () => {
  assert.deepEqual(parseInvidiousResults([
    { type: 'playlist', playlistId: 'RDMMbD6ifecX6rs', title: 'My Mix' },
    { type: 'video', videoId: 'bD6ifecX6rs', title: 'Selected video' },
  ]), [{ kind: 'video', id: 'bD6ifecX6rs', title: 'Selected video' }]);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Mix must not make a playlist request'); };
  try {
    assert.equal(await loadYouTubePlaylistPreview('RDMMbD6ifecX6rs'), null);
    assert.deepEqual(await loadYouTubePlaylist('RDMMbD6ifecX6rs'), []);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('a metadata-only success falls through to a working provider and loads all 139 videos', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const entries = Array.from({ length: 139 }, (_, index) => ({
    videoId: `v${String(index).padStart(10, '0')}`, title: `Video ${index + 1}`,
  }));
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    const page = Number(url.searchParams.get('page'));
    return Response.json({ videoCount: 139, videos: url.hostname === 'invidious.f5.si'
      ? [] : entries.slice((page - 1) * 50, page * 50) });
  };
  try {
    assert.deepEqual(await loadYouTubePlaylist('PL6aMbZ8nbxi5QacGkSzerXroSqxanMTVb'), entries);
    assert.equal(requests.length, 6);
    assert.equal(new URL(requests.at(-1)!).searchParams.get('page'), '3');
  } finally { globalThis.fetch = originalFetch; }
});

test('metadata without accessible videos rejects instead of silently returning an empty queue', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ videoCount: 139, videos: [] });
  try {
    await assert.rejects(loadYouTubePlaylist('PL6aMbZ8nbxi5QacGkSzerXroSqxanMTVb'));
  } finally { globalThis.fetch = originalFetch; }
});

test('pagination uses raw page size even when some entries cannot be imported', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input) => {
    const page = Number(new URL(String(input)).searchParams.get('page'));
    requests++;
    const videos = Array.from({ length: page === 1 ? 50 : 10 }, (_, index) => ({
      videoId: index === 0 && page === 1 ? 'private' : `v${String(page * 100 + index).padStart(10, '0')}`,
      title: 'Video',
    }));
    return Response.json({ videoCount: 60, videos });
  };
  try {
    assert.equal((await loadYouTubePlaylist('PL6aMbZ8nbxi5QacGkSzerXroSqxanMTVb')).length, 59);
    assert.equal(requests, 2);
  } finally { globalThis.fetch = originalFetch; }
});
