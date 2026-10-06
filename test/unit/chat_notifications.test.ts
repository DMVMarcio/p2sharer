import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldNotifyChat, shouldPlayChatSound } from '../../src/core/chat_notifications.ts';
import { SoundEffectsManager, SOUND_EVENTS } from '../../src/ui/sound_effects.ts';

const incoming = { id: 'message-1', sender: 'Peer', authorId: 'remote', text: 'Hello', timestamp: 1, revision: 0 };

test('chat sounds require an unfocused app or hidden chat', () => {
  assert.equal(shouldPlayChatSound(true, false, 'chat'), false);
  assert.equal(shouldPlayChatSound(false, false, 'chat'), true);
  assert.equal(shouldPlayChatSound(true, true, 'chat'), true);
  assert.equal(shouldPlayChatSound(true, false, 'participants'), true);
  assert.equal(shouldPlayChatSound(false, true, 'participants'), true);
});

test('chat notifications exclude history duplicates, own messages, notices and revisions', () => {
  assert.equal(shouldNotifyChat(incoming, [], 'local'), true);
  assert.equal(shouldNotifyChat({ ...incoming, file: { name: 'file.txt', size: 1, sha256: '', isImage: false } }, [], 'local'), true);
  assert.equal(shouldNotifyChat(incoming, [incoming], 'local'), false);
  for (const update of [{ authorId: 'local' }, { isSystem: true }, { revision: 1 }, { editedAt: 2 }, { deletedAt: 2 }]) {
    assert.equal(shouldNotifyChat({ ...incoming, ...update }, [], 'local'), false);
  }
});

test('sound switches persist independently and previews leave saved settings untouched', () => {
  const saved = new Map<string, string>([['p2sharer_sfx_enabled', 'false'], ['p2sharer_sfx_volume', '0.35']]);
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let tones = 0;
  const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
  class AudioContextFixture {
    currentTime = 0; state = 'running'; destination = {};
    createGain() { return { gain: param, connect() {}, disconnect() {} }; }
    createOscillator() { return { frequency: param, connect() {}, disconnect() {}, start() { tones++; }, stop() {} }; }
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: AudioContextFixture } });
  try {
    const sounds = new SoundEffectsManager();
    assert.equal(sounds.getEnabled(), false);
    assert.equal(sounds.getVolume(), 0.35);
    sounds.setEventPreferences({ ...sounds.getEventPreferences(), message: false, userLeave: false });
    const reloaded = new SoundEffectsManager();
    assert.equal(reloaded.getEventPreferences().message, false);
    assert.equal(reloaded.getEventPreferences().userJoin, true);
    sounds.playMessage();
    assert.equal(tones, 0);
    const persisted = [...saved];
    for (const event of SOUND_EVENTS) sounds.preview(event, 0.7);
    assert.ok(tones > 0);
    assert.deepEqual([...saved], persisted);
    assert.equal(sounds.getEnabled(), false);
    assert.equal(sounds.getVolume(), 0.35);
    assert.equal(sounds.getEventPreferences().message, false);
    sounds.setEnabled(true);
    const afterPreview = tones;
    sounds.playMessage();
    sounds.playUserLeave();
    assert.equal(tones, afterPreview);
    sounds.playUserJoin();
    assert.ok(tones > afterPreview);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
