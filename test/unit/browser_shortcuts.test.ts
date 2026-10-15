import assert from 'node:assert/strict';
import test from 'node:test';
import { browserHistoryButton, browserShortcut } from '../../src/apps/browser_shortcuts.ts';
import { validBrowserCommand } from '../../src/apps/browser_protocol.ts';

test('browser navigation shortcuts select the address, reload normally or bypass cache, and navigate history', () => {
  const key = (key: string, modifiers = {}) => browserShortcut({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...modifiers });
  assert.equal(key('F6'), 'address'); assert.equal(key('l', { ctrlKey: true }), 'address');
  for (const symbol of ['+', '=']) assert.deepEqual(key(symbol, { ctrlKey: true }), { kind: 'zoom', direction: 1 });
  assert.deepEqual(key('-', { ctrlKey: true }), { kind: 'zoom', direction: -1 });
  assert.deepEqual(key('0', { ctrlKey: true }), { kind: 'zoom', direction: 0 });
  assert.equal(key('+'), null);
  assert.equal(validBrowserCommand({ kind: 'zoom', direction: 2 }), false);
  assert.equal(validBrowserCommand({ kind: 'zoom', direction: '1' }), false);
  assert.deepEqual(key('F5'), { kind: 'reload', ignore_cache: false });
  for (const modifiers of [{ ctrlKey: true }, { shiftKey: true }]) assert.deepEqual(key('F5', modifiers), { kind: 'reload', ignore_cache: true });
  assert.deepEqual(key('R', { ctrlKey: true, shiftKey: true }), { kind: 'reload', ignore_cache: true });
  assert.deepEqual(key('ArrowLeft', { altKey: true }), { kind: 'back' });
  assert.deepEqual(key('BrowserForward'), { kind: 'forward' }); assert.equal(key('r'), null);
  assert.deepEqual(browserHistoryButton(3), { kind: 'back' }); assert.deepEqual(browserHistoryButton(4), { kind: 'forward' });
  for (const button of [0, 1, 2]) assert.equal(browserHistoryButton(button), null);
  assert.equal(validBrowserCommand({ kind: 'move-tab', id: 1, before: 2 }), true);
  assert.equal(validBrowserCommand({ kind: 'move-tab', id: 1, before: null }), true);
  assert.equal(validBrowserCommand({ kind: 'move-tab', id: 1, before: -1 }), false);
  assert.equal(validBrowserCommand({ kind: 'reload', ignore_cache: 'yes' }), false);
});
