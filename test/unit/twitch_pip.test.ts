import assert from 'node:assert/strict';
import test from 'node:test';
import {
  twitchPipEvent,
  twitchPipPeerId,
  validTwitchPipCommand,
  validTwitchPipSettings,
} from '../../src/apps/twitch_pip.ts';

test('each Twitch app instance receives a distinct native PiP window and local event channel', () => {
  assert.equal(twitchPipPeerId('first'), 'twitch-first');
  assert.notEqual(twitchPipPeerId('first'), twitchPipPeerId('second'));
  assert.notEqual(twitchPipEvent('first'), twitchPipEvent('second'));
});

test('Twitch PiP local audio settings stay within valid bounds', () => {
  assert.equal(validTwitchPipSettings({ volume: 80, muted: false }), true);
  assert.equal(validTwitchPipSettings({ volume: 0, muted: true }), true);
  assert.equal(validTwitchPipSettings({ volume: 101, muted: false }), false);
  assert.equal(validTwitchPipSettings({ volume: -5, muted: false }), false);
  assert.equal(validTwitchPipSettings({ volume: 20, muted: 'false' }), false);
});

test('Twitch PiP accepts only valid playback commands', () => {
  assert.equal(validTwitchPipCommand({ action: 'toggle' }), true);
  assert.equal(validTwitchPipCommand({ action: 'seek', position: 42 }), false);
  assert.equal(validTwitchPipCommand({ action: 'stop' }), false);
});
