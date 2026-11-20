import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import {
  clearSessionAppVolumes,
  getSavedStreamVolume,
  getSessionAppVolume,
  getStreamVolumePreferenceKey,
  saveSessionAppVolume,
  saveStreamVolume,
} from '../../src/core/stream_volume_preferences.ts';
import {
  getChatMessageCategory,
  matchesChatFilter,
  DEFAULT_CHAT_FILTERS,
} from '../../src/core/chat_filters.ts';

test('stream volume preferences match broadcaster identity + screen across new peerIds and separate sources', () => {
  const map = new Map();
  const storage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
  };

  const day1Key = getStreamVolumePreferenceKey({
    isLocal: false,
    ownerPublicKey: '04abcd1234',
    senderName: 'Marcio',
    mediaKind: 'screen',
    mediaLabel: 'Display 1',
  });
  const secondScreenKey = getStreamVolumePreferenceKey({
    isLocal: false,
    ownerPublicKey: '04abcd1234',
    senderName: 'Marcio',
    mediaKind: 'screen',
    mediaLabel: 'Counter-Strike 2',
  });

  saveStreamVolume(day1Key, 35, false, storage);
  saveStreamVolume(secondScreenKey, 80, true, storage);

  const day2Key = getStreamVolumePreferenceKey({
    isLocal: false,
    ownerPublicKey: '04abcd1234',
    senderName: 'Marcio (renamed)',
    mediaKind: 'screen',
    mediaLabel: 'Display 1',
  });

  assert.equal(day2Key, day1Key);
  assert.notEqual(day1Key, secondScreenKey);
  assert.deepEqual(getSavedStreamVolume(day2Key, storage), { volume: 35, isMuted: false });
  assert.deepEqual(getSavedStreamVolume(secondScreenKey, storage), { volume: 80, isMuted: true });
  assert.equal(getStreamVolumePreferenceKey({ isLocal: true, senderName: 'Me', mediaKind: 'screen', mediaLabel: 'Display 1' }), undefined);

  clearSessionAppVolumes();
  saveSessionAppVolume('browser:app-1', 42, false);
  assert.deepEqual(getSessionAppVolume('browser:app-1'), { volume: 42, isMuted: false });
  clearSessionAppVolumes();
  assert.equal(getSessionAppVolume('browser:app-1'), null);
});

test('AudioContextManager restores and persists stream volume across attach/detach cycles', () => {
  const prevStorage = globalThis.localStorage;
  const prevWindow = globalThis.window;
  const prevDoc = globalThis.document;
  const data = new Map();
  const gains = [];

  globalThis.localStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
  globalThis.document = {
    createElement: () => ({
      autoplay: false,
      volume: 1,
      hidden: false,
      paused: false,
      srcObject: null,
      setAttribute() {},
      play: () => Promise.resolve(),
      pause() {},
      remove() {},
    }),
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = {
    AudioContext: class {
      state = 'running';
      destination = {};
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
      createGain() {
        const node = { gain: { value: 1 }, connect() {}, disconnect() {} };
        gains.push(node);
        return node;
      }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
    },
  };

  return import('../../src/audio/audio_context_manager.ts').then(({ AudioContextManager }) => {
    try {
      const mgr = new AudioContextManager();
      const fakeStream = { id: 's1', getAudioTracks: () => [] };
      const key = getStreamVolumePreferenceKey({
        isLocal: false,
        ownerPublicKey: '04key1',
        senderName: 'Marcio',
        mediaKind: 'screen',
        mediaLabel: 'Monitor 1',
      });

      const first = mgr.attachPeerAudio('peer-session-1/s1', fakeStream, key);
      assert.equal(first.volume, 100);
      mgr.setPeerVolume('peer-session-1/s1', 28, true, key);
      mgr.detachPeerAudio('peer-session-1/s1');

      const next = mgr.attachPeerAudio('peer-session-2/s9', { id: 's2', getAudioTracks: () => [] }, key);
      assert.equal(next.volume, 28);
      assert.equal(next.isMuted, true);
      assert.equal(next.gainNode.gain.value, 0);

      mgr.setPeerVolume('peer-session-2/s9', 65, false, key);
      assert.equal(next.gainNode.gain.value, 0.65);
      mgr.detachPeerAudio('peer-session-2/s9');
      assert.deepEqual(getSavedStreamVolume(key), { volume: 65, isMuted: false });
    } finally {
      globalThis.localStorage = prevStorage;
      globalThis.window = prevWindow;
      globalThis.document = prevDoc;
    }
  });
});

test('chat filters classify notices and ChatPane filters messages interactively via its popover menu', async () => {
  assert.equal(getChatMessageCategory({ id: '1', sender: 'Ana', text: 'Oi', timestamp: 1 }), 'messages');
  assert.equal(getChatMessageCategory({ id: '2', sender: 'Sistema', text: '', timestamp: 2, isSystem: true, systemType: 'app-start' }), 'apps');
  assert.equal(getChatMessageCategory({ id: '3', sender: 'Sistema', text: '', timestamp: 3, isSystem: true, systemType: 'stream-start' }), 'streams');
  assert.equal(getChatMessageCategory({ id: '4', sender: 'Sistema', text: '', timestamp: 4, isSystem: true, systemType: 'join' }), 'presence');
  assert.equal(getChatMessageCategory({ id: '5', sender: 'Sistema', text: '', timestamp: 5, isSystem: true, systemType: 'info' }), 'events');
  assert.equal(matchesChatFilter({ id: '1', sender: 'Ana', text: 'Oi', timestamp: 1 }, DEFAULT_CHAT_FILTERS), true);

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
  const keys = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'];
  const prev = new Map(keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const k of keys.slice(0, -1)) {
    Object.defineProperty(globalThis, k, {
      configurable: true,
      value: k.endsWith('AnimationFrame') ? dom.window[k].bind(dom.window) : dom.window[k],
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => {};

  globalThis.chatFilterFixture = {
    messages: [
      { id: 'm1', authorId: 'p1', sender: 'Marcio', text: 'Bora jogar', timestamp: 1000 },
      { id: 's1', sender: 'Sistema', text: '', timestamp: 2000, isSystem: true, systemType: 'app-start', systemActor: 'Marcio', systemAppKind: 'chess' },
      { id: 's2', sender: 'Sistema', text: '', timestamp: 3000, isSystem: true, systemType: 'stream-start', systemActor: 'Marcio' },
      { id: 's3', sender: 'Sistema', text: '', timestamp: 4000, isSystem: true, systemType: 'join', systemActor: 'Ana' },
    ],
  };

  let root;
  try {
    const require = createRequire(import.meta.url);
    const bundle = await build({
      stdin: {
        contents: `export { ChatPane } from './src/components/room/ChatPane.tsx';
          export { ContextMenuProvider } from './src/components/common/ContextMenu.tsx';
          export { resetChatFilters } from './src/core/chat_filters.ts';`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      jsx: 'automatic',
      loader: { '.css': 'empty', '.png': 'dataurl' },
      plugins: [{
        name: 'chat-filter-fixture',
        setup(builder) {
          builder.onResolve({ filter: /hooks\/useRoom$|hooks\/useChatFileInput$|room\/ChatTransferCenter$|common\/EmojiComposerInput$/ }, (args) => ({
            path: args.path.split('/').at(-1),
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            contents: {
              EmojiComposerInput: `import React from 'react'; export const EmojiComposerInput = React.forwardRef((props, ref) => {
                React.useImperativeHandle(ref, () => ({ focus() {}, hasText: () => false }));
                return React.createElement('textarea', { 'aria-label': props['aria-label'] });
              });`,
              useRoom: `export const useRoom = () => ({
                roomSlots: [], chatMessages: globalThis.chatFilterFixture.messages,
                sendChatMessage() {}, editChatMessage: async () => true, deleteChatMessage: async () => true,
                offerFile: async () => {}, requestFile: async () => {}, requestFilePreview: async () => {},
                cancelFileTransfer: async () => {}, fileProgress: {}, localFilePreviews: {}, imagePreviews: {},
                savedDownloads: {}, revealSavedFile: async () => {}, peers: [], username: 'Tester',
                isCreator: false, isRoomAdmin: false,
              });`,
              useChatFileInput: `export const useChatFileInput = () => ({
                selectedFile: null, dragging: false, close() {}, markOffered() {}, pickFile: async () => {},
              });`,
              ChatTransferCenter: `export function ChatTransferCenter() { return null; }`,
            }[args.path],
          }));
          builder.onResolve({ filter: /^[^./]/ }, (args) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
        },
      }],
    });

    const { ChatPane, ContextMenuProvider, resetChatFilters } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
    const { createRoot } = await import('react-dom/client');
    root = createRoot(document.getElementById('root'));

    await act(async () => {
      resetChatFilters();
      root.render(React.createElement(ContextMenuProvider, null, React.createElement(ChatPane)));
    });

    assert.equal(document.querySelectorAll('.chat-msg, .chat-system-msg').length, 4);

    await act(async () => {
      document.querySelector('.btn-chat-filter').click();
    });
    const checkboxes = [...document.querySelectorAll('.chat-filter-menu input[type="checkbox"]')];
    assert.equal(checkboxes.length, 5);
    assert.ok(checkboxes.every((box) => box.checked));

    // Uncheck Streams (index 1) and Apps (index 2).
    await act(async () => { checkboxes[1].click(); });
    await act(async () => { checkboxes[2].click(); });

    assert.equal(document.querySelectorAll('.chat-msg').length, 1);
    assert.equal(document.querySelectorAll('.chat-system-msg').length, 1);
    assert.equal(document.querySelector('.chat-system-msg').dataset.systemType, 'join');
    assert.ok(document.querySelector('.chat-filter-dot'));

    // Uncheck remaining Messages (index 0) and Presence (index 3) -> empty filter state + Show all.
    await act(async () => { checkboxes[0].click(); });
    await act(async () => { checkboxes[3].click(); });
    assert.equal(document.querySelectorAll('.chat-msg, .chat-system-msg').length, 0);
    assert.ok(document.querySelector('.chat-filter-empty'));

    await act(async () => {
      document.querySelector('.chat-filter-empty button').click();
    });
    assert.equal(document.querySelectorAll('.chat-msg, .chat-system-msg').length, 4);
    assert.equal(document.querySelector('.chat-filter-dot'), null);
  } finally {
    if (root) await act(async () => root.unmount());
    delete globalThis.chatFilterFixture;
    dom.window.close();
    for (const [k, d] of prev) {
      if (d) Object.defineProperty(globalThis, k, d);
      else Reflect.deleteProperty(globalThis, k);
    }
  }
});
