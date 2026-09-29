import assert from 'node:assert/strict';
import test from 'node:test';
import { validYouTubePipCommand, validYouTubePipSettings, youtubePipEvent,
  youtubePipPeerId } from '../../src/apps/youtube_pip.ts';

test('each activity instance receives a distinct native PiP window and local event channel', () => {
  assert.equal(youtubePipPeerId('first'), 'youtube-first');
  assert.notEqual(youtubePipPeerId('first'), youtubePipPeerId('second'));
  assert.notEqual(youtubePipEvent('first'), youtubePipEvent('second'));
});

test('PiP local audio and caption settings stay within valid bounds', () => {
  assert.equal(validYouTubePipSettings({ volume: 80, muted: false, captions: true }), true);
  assert.equal(validYouTubePipSettings({ volume: 101, muted: false, captions: true }), false);
  assert.equal(validYouTubePipSettings({ volume: 20, muted: 'false', captions: true }), false);
});

test('PiP accepts only bounded shared playback commands', () => {
  assert.equal(validYouTubePipCommand({ action: 'toggle' }), true);
  assert.equal(validYouTubePipCommand({ action: 'seek', position: 42 }), true);
  assert.equal(validYouTubePipCommand({ action: 'seek', position: -1 }), false);
  assert.equal(validYouTubePipCommand({ action: 'seek', position: Infinity }), false);
  assert.equal(validYouTubePipCommand({ action: 'stop' }), false);
});
