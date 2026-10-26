import assert from 'node:assert/strict';
import test from 'node:test';
import { describeTwitchActivity } from '../../src/apps/twitch_activity.ts';
import { parseTwitchChannel } from '../../src/apps/twitch_player.ts';
import { validTwitchState } from '../../src/apps/models.ts';
import type { TwitchState } from '../../src/apps/types.ts';

const baseState: TwitchState = {
  channel: 'channel_a',
  playing: true,
  updatedAt: 1000,
};

test('twitch activity describes channel changes and playback transitions', () => {
  assert.equal(
    describeTwitchActivity(baseState, { ...baseState, channel: 'channel_b', syncReason: 'channel' }),
    'mudou para o canal “channel_b”'
  );
  assert.equal(
    describeTwitchActivity(baseState, { ...baseState, playing: false, syncReason: 'playback' }),
    'pausou a transmissão'
  );
  assert.equal(
    describeTwitchActivity({ ...baseState, playing: false }, { ...baseState, playing: true, syncReason: 'playback' }),
    'retomou a transmissão'
  );
  assert.equal(
    describeTwitchActivity(baseState, { ...baseState }),
    null
  );
});

test('twitch channel input parsing handles URLs, mentions, and plain names', () => {
  assert.equal(parseTwitchChannel('streamer'), 'streamer');
  assert.equal(parseTwitchChannel('https://www.twitch.tv/streamer'), 'streamer');
  assert.equal(parseTwitchChannel('https://twitch.tv/streamer?referral=123'), 'streamer');
  assert.equal(parseTwitchChannel('@streamer'), 'streamer');
  assert.equal(parseTwitchChannel('   live_gaming   '), 'live_gaming');
  assert.equal(parseTwitchChannel('invalid channel with spaces'), null);
  assert.equal(parseTwitchChannel(''), null);
});

test('twitch state validator accepts valid states and rejects invalid shapes', () => {
  assert.equal(validTwitchState(baseState), true);
  assert.equal(validTwitchState({ channel: '', playing: true, updatedAt: 1 }), true);
  assert.equal(validTwitchState({ channel: 'valid_channel', playing: false, updatedAt: 200, syncReason: 'channel' }), true);
  assert.equal(validTwitchState({ channel: 123, playing: true, updatedAt: 1 }), false);
  assert.equal(validTwitchState({ channel: 'channel_too_long_exceeding_twenty_five_chars', playing: true, updatedAt: 1 }), false);
  assert.equal(validTwitchState({ channel: 'bad!chars', playing: true, updatedAt: 1 }), false);
  assert.equal(validTwitchState({ channel: 'ok', playing: 'yes', updatedAt: 1 }), false);
  assert.equal(validTwitchState({ channel: 'ok', playing: true, updatedAt: -5 }), false);
});
