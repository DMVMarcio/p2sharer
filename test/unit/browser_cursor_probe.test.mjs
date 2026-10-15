import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

test('isolated cursor telemetry identifies text and clickable controls without overriding page selection', () => {
  const dom = new JSDOM('<p>Selectable text</p><a href="https://example.com">Link</a><input><input type="range"><button>Button</button>', { runScripts: 'outside-only' });
  const { window } = dom; let move; let target = window.document.querySelector('p'); let caret = false; const shapes = [];
  const original = window.document.addEventListener.bind(window.document);
  window.document.addEventListener = (name, callback, options) => { if (name === 'mousemove') move = callback; else original(name, callback, options); };
  window.document.elementFromPoint = () => target;
  window.document.caretRangeFromPoint = () => caret ? { startContainer: window.document.querySelector('p').firstChild, startOffset: 1,
    setStart() {}, setEnd() {}, getClientRects: () => [{ left: 0, top: 0, right: 20, bottom: 20 }] } : null;
  window.requestAnimationFrame = callback => { callback(); return 1; };
  window.reportCursor = shape => shapes.push(shape);
  const script = readFileSync(new URL('../../src-tauri/src/browser_cursor.js', import.meta.url), 'utf8').replace('__P2SHARER_CURSOR_BINDING__', '"reportCursor"');
  try {
    window.eval(script);
    const hover = selector => { target = window.document.querySelector(selector); move({ isTrusted: true, clientX: 10, clientY: 10 }); return shapes.at(-1); };
    assert.equal(hover('p'), 'default'); caret = true; assert.equal(hover('p'), 'text'); caret = false;
    assert.equal(hover('a'), 'pointer'); assert.equal(hover('button'), 'pointer'); assert.equal(hover('input'), 'text');
    assert.equal(hover('input[type=range]'), 'default');
    target.style.cursor = 'pointer'; assert.equal(hover('input[type=range]'), 'pointer');
    const before = shapes.length; move({ isTrusted: false, clientX: 10, clientY: 10 }); assert.equal(shapes.length, before);
  } finally { window.close(); }
});
