import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const probe = readFileSync(new URL('../../src-tauri/src/browser_video_probe.js', import.meta.url), 'utf8');
test('native browser probe detects visible playback, including shadow players, and ignores paused or hidden video', () => {
  const dom = new JSDOM('<video></video><div id="player"></div>', { runScripts: 'outside-only' });
  const { window } = dom;
  // jsdom does not invalidate computed styles inside shadow trees reliably.
  window.getComputedStyle = element => ({ visibility: element.style.visibility || 'visible',
    display: element.style.display || 'block', opacity: element.style.opacity || '1' });
  const video = window.document.querySelector('video');
  let paused = false; let visible = true; let ready = 2;
  const setup = element => {
    Object.defineProperties(element, {
      paused: { get: () => paused }, ended: { value: false }, readyState: { get: () => ready },
    });
    element.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 });
    element.checkVisibility = () => visible;
    // jsdom has no layout engine; provide the computed opacity WebView2 exposes.
    element.style.opacity = '1';
  };
  setup(video);
  try {
    assert.equal(window.eval(probe), true);
    paused = true; assert.equal(window.eval(probe), false);
    paused = false; visible = false; assert.equal(window.eval(probe), false);
    visible = true; ready = 1; assert.equal(window.eval(probe), false);
    ready = 2; video.remove();
    const shadow = window.document.getElementById('player').attachShadow({ mode: 'open' });
    const embedded = window.document.createElement('video'); setup(embedded); shadow.append(embedded);
    assert.equal(window.eval(probe), true);
    embedded.style.visibility = 'hidden'; assert.equal(window.eval(probe), false);
  } finally { window.close(); }
});

test('native browser probe recognizes prominent visible game canvases without creating GPU contexts', () => {
  const dom = new JSDOM('<canvas width="800" height="600"></canvas>', { runScripts: 'outside-only' });
  const { window } = dom;
  const canvas = window.document.querySelector('canvas');
  canvas.style.opacity = '1';
  let visible = true; let width = 800; let height = 600;
  canvas.checkVisibility = () => visible;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: height, width, height });
  canvas.getContext = () => { throw new Error('Detection must not allocate or change the game context'); };
  try {
    assert.equal(window.eval(probe), true);
    visible = false; assert.equal(window.eval(probe), false);
    visible = true; width = height = 100; assert.equal(window.eval(probe), false);
    width = 800; height = 600; canvas.style.display = 'none'; assert.equal(window.eval(probe), false);
  } finally { window.close(); }
});
