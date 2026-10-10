import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NICKNAME_STYLE, normalizeNicknameStyle } from '../../src/core/nickname_style.ts';

test('nickname presence and persisted settings reject arbitrary CSS and unknown registry entries', () => {
  for (const value of [null, [], 'red', {}, { font: '__proto__', effect: 'url(secret)', animation: 'custom',
    color: 'var(--secret)', secondaryColor: '#fff' }]) {
    assert.deepEqual(normalizeNicknameStyle(value), DEFAULT_NICKNAME_STYLE);
  }
  assert.deepEqual(normalizeNicknameStyle({ font: 'default', effect: 'gradient', animation: 'wave',
    color: '#ABCDEF', secondaryColor: '#123456', backgroundImage: 'url(secret)' }), {
    font: 'default', effect: 'gradient', animation: 'wave', color: '#abcdef', secondaryColor: '#123456',
  });
});
