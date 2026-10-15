import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('offscreen game capture relays relative motion and releases without locking the host mouse', async () => {
  const dom = new JSDOM('<canvas></canvas>', { runScripts: 'outside-only', url: 'https://example.com/' });
  const { window } = dom;
  const document = window.document;
  const reports = [];
  window.reportLock = value => reports.push(value);
  const gestures = new Map();
  const original = document.addEventListener.bind(document);
  document.addEventListener = (type, callback, options) => {
    if (!gestures.has(type)) gestures.set(type, callback);
    original(type, callback, options);
  };
  try {
    const source = await readFile(new URL('../../src-tauri/src/browser_pointer_lock.js', import.meta.url), 'utf8');
    window.eval(source.replaceAll('__P2SHARER_CURSOR_BINDING__', '"reportLock"'));
    const canvas = document.querySelector('canvas');
    await assert.rejects(canvas.requestPointerLock(), { name: 'NotAllowedError' });
    assert.equal(document.pointerLockElement, null);
    // The CDP input boundary delivers a trusted engagement gesture to the page.
    gestures.get('mousedown')({ isTrusted: true });
    await canvas.requestPointerLock();
    assert.equal(document.pointerLockElement, canvas);
    assert.equal(reports.at(-1), 'locked');
    const motion = [];
    document.addEventListener('mousemove', event => motion.push([event.movementX, event.movementY]));
    window.__p2sharerRelativeMouse(23, -7);
    window.__p2sharerRelativeMouse(Infinity, 0);
    window.__p2sharerRelativeMouse(5001, 0);
    assert.deepEqual(motion, [[23, -7]]);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(document.pointerLockElement, null);
    assert.equal(reports.at(-1), 'unlocked');
    window.__p2sharerRelativeMouse(1, 1);
    assert.equal(motion.length, 1);
  } finally { dom.window.close(); }
});
