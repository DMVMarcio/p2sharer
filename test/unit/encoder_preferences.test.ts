import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEncoderPreference, normalizeEncoderPreference, saveEncoderPreference } from '../../src/core/encoder_preferences.ts';

test('encoder preferences recover after GPU changes and preserve generic selection', () => {
  assert.equal(normalizeEncoderPreference(null, true), 'auto');
  assert.equal(normalizeEncoderPreference('nvenc', true), 'nvenc');
  assert.equal(normalizeEncoderPreference('nvenc', false), 'auto');
  assert.equal(normalizeEncoderPreference('generic', true), 'generic');
  assert.equal(normalizeEncoderPreference('amd', false), 'auto');
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }});
  try {
    saveEncoderPreference('nvenc');
    assert.equal(getEncoderPreference(), 'nvenc');
    assert.equal(getEncoderPreference(false), 'auto');
    assert.equal(values.get('p2sharer_video_encoder'), 'auto');
    saveEncoderPreference('generic');
    assert.equal(getEncoderPreference(false), 'generic');
    values.set('p2sharer_video_encoder', 'unknown-future-backend');
    assert.equal(getEncoderPreference(true), 'auto');
    assert.equal(values.get('p2sharer_video_encoder'), 'auto');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
