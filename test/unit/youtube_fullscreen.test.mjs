import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

test('YouTube fullscreen control preserves the player and follows fullscreen exit, failures and disposal', async () => {
  const require = createRequire(import.meta.url);
  const bundle = await build({ stdin: { contents: `
    export { useElementFullscreen } from './src/hooks/useElementFullscreen';
    export { YouTubeControls } from './src/apps/YouTubeControls';`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
    plugins: [{ name: 'fullscreen-fixture', setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/(core|window)$/ }, args => ({ path: args.path, namespace: 'native' }));
      builder.onLoad({ filter: /.*/, namespace: 'native' }, args => ({ contents: args.path.endsWith('/window')
        ? 'export const getCurrentWindow = () => globalThis.youtubeFullscreenWindow;'
        : 'export const isTauri = () => true;' }));
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }] });
  const { useElementFullscreen, YouTubeControls } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys.slice(0, -1)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  let active = null, fail = false, failure = null;
  let nativeFullscreen = false;
  const initialBounds = { x: 80, y: 120, width: 640, height: 360 };
  let bounds = { ...initialBounds };
  globalThis.youtubeFullscreenWindow = {
    isFullscreen: async () => nativeFullscreen,
    setFullscreen: async value => { nativeFullscreen = value; },
    outerPosition: async () => ({ x: bounds.x, y: bounds.y }),
    innerSize: async () => ({ width: bounds.width, height: bounds.height }),
    isMaximized: async () => false,
    setSize: async size => { bounds.width = size.width; bounds.height = size.height; },
    setPosition: async position => { bounds.x = position.x; bounds.y = position.y; },
  };
  Object.defineProperty(document, 'fullscreenElement', { get: () => active });
  const changed = () => document.dispatchEvent(new window.Event('fullscreenchange'));
  document.exitFullscreen = async () => { active = null; changed(); };
  window.HTMLElement.prototype.requestFullscreen = async function () {
    if (fail) throw new Error('Fullscreen denied');
    // Model WebView2's host transition as well as its DOM top layer.
    nativeFullscreen = true;
    bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    active = this; changed();
  };
  const noop = () => {};
  const Harness = () => {
    const { ref, fullscreen, toggleFullscreen } = useElementFullscreen();
    return React.createElement('div', { ref }, React.createElement('iframe', { title: 'Player' }),
      React.createElement(YouTubeControls, { hasVideo: true, playing: true, hasPrevious: false, hasNext: false,
        position: 12, duration: 60, buffered: 1, volume: 80, muted: false, captions: false,
        onTogglePlayback: noop, onPrevious: noop, onNext: noop, onSeek: noop, onVolume: noop,
        onToggleMute: noop, onToggleCaptions: noop, fullscreen,
        onToggleFullscreen: () => void toggleFullscreen().catch(error => { failure = error; }) }));
  };
  try {
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Harness))));
    const iframe = document.querySelector('iframe');
    const button = () => [...document.querySelectorAll('button')].at(-1);
    assert.equal(button().getAttribute('aria-pressed'), 'false');
    await act(async () => button().click());
    assert.equal(button().getAttribute('aria-pressed'), 'true');
    assert.equal(active, iframe.parentElement);
    assert.equal(nativeFullscreen, true);
    assert.equal(document.querySelector('iframe'), iframe);
    await act(async () => button().click());
    assert.equal(active, null);
    assert.equal(nativeFullscreen, false);
    assert.deepEqual(bounds, initialBounds);
    await act(async () => button().click());
    await act(async () => document.exitFullscreen()); // Escape/system exit.
    assert.equal(button().getAttribute('aria-pressed'), 'false');
    assert.equal(nativeFullscreen, false);
    assert.deepEqual(bounds, initialBounds);
    fail = true;
    await act(async () => button().click());
    assert.match(failure.message, /denied/);
    assert.equal(button().getAttribute('aria-pressed'), 'false');
    fail = false;
    await act(async () => button().click());
    assert.equal(document.querySelector('iframe'), iframe);
    await act(async () => root.unmount());
    assert.equal(active, null);
    assert.equal(nativeFullscreen, false);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    delete globalThis.youtubeFullscreenWindow;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
