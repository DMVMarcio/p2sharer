import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';

const browser = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent']) globalThis[key] = browser.window[key];
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false });
HTMLElement.prototype.scrollIntoView = () => {};
const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: "export * from './src/components/common/Select.tsx'; export * from './src/components/common/ModalDialog.tsx';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [{ name: 'packages', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, (args) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { Select, ModalDialog } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=select-test-bundle.js').toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
const options = [{ value: 1, label: 'Alpha' }, { value: 2, label: 'Beta', disabled: true }, { value: 3, label: 'Charlie' }, { value: 4, label: 'Delta' }];
let changes = [];
function Fixture({ disabled = false }) {
  const [value, setValue] = useState(1);
  return React.createElement('div', null,
    React.createElement('label', { htmlFor: 'first' }, 'First selector'),
    React.createElement(Select, { id: 'first', value, options, disabled, onValueChange: (next) => { changes.push(next); setValue(next); } }),
    React.createElement(Select, { id: 'second', value: 1, options, 'aria-label': 'Second selector', onValueChange() {} }),
    React.createElement('button', { id: 'outside' }, 'Outside'));
}
const render = async (props) => { await act(async () => root.render(React.createElement(Fixture, props))); };
const click = async (selector) => { await act(async () => document.querySelector(selector).click()); };
const key = async (key) => { await act(async () => document.getElementById('first').dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))); };
const activeLabel = () => document.getElementById(document.getElementById('first').getAttribute('aria-activedescendant'))?.textContent;
const finishExit = async () => { await act(async () => await new Promise((resolve) => setTimeout(resolve, 280))); };
await render();
after(async () => { await act(async () => root.unmount()); browser.window.close(); });

test('keyboard navigation skips disabled options and commits numeric options as string values', async () => {
  document.getElementById('first').focus();
  await key('ArrowDown');
  assert.equal(document.activeElement.id, 'first');
  assert.equal(activeLabel(), 'Alpha');
  await key('ArrowDown');
  assert.equal(activeLabel(), 'Charlie');
  await key('End');
  assert.equal(activeLabel(), 'Delta');
  await key('Home');
  assert.equal(activeLabel(), 'Alpha');
  await key('ArrowDown');
  await key('Enter');
  assert.deepEqual(changes, ['3']);
  assert.match(document.getElementById('first').textContent, /Charlie/);
  assert.equal(document.querySelector('[role="listbox"]').hasAttribute('inert'), true);
  await finishExit();
  assert.equal(document.querySelector('[role="listbox"]'), null);
});

test('typeahead and Escape preview choices without changing the controlled value', async () => {
  await key('d');
  assert.equal(activeLabel(), 'Delta');
  await key('Escape');
  assert.deepEqual(changes, ['3']);
  await finishExit();
});

test('pointer selection cannot choose disabled options and outside click dismisses without a commit', async () => {
  await click('#first');
  await click('[role="option"][aria-disabled="true"]');
  assert.equal(document.getElementById('first').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(changes, ['3']);
  await act(async () => document.getElementById('outside').dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
  assert.equal(document.getElementById('first').getAttribute('aria-expanded'), 'false');
  await finishExit();
  await click('#first');
  await click('[role="option"][data-option-index="3"]');
  assert.deepEqual(changes, ['3', '4']);
  await finishExit();
});

test('opening another selector closes the previous one; disabled fields cannot open', async () => {
  await click('#first');
  await click('#second');
  assert.equal(document.getElementById('first').getAttribute('aria-expanded'), 'false');
  assert.equal(document.getElementById('second').getAttribute('aria-expanded'), 'true');
  await render({ disabled: true });
  await click('#first');
  assert.equal(document.getElementById('first').getAttribute('aria-expanded'), 'false');
  await act(async () => document.getElementById('outside').dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
  await finishExit();
});

test('Escape closes the list before its enclosing modal', async () => {
  let closed = 0;
  await act(async () => root.render(React.createElement(ModalDialog, { title: 'Dialog', onClose: () => closed++ },
    React.createElement(Select, { id: 'first', 'aria-label': 'Choice', value: 1, options, onValueChange() {} }))));
  await key('Enter');
  await key('Escape');
  await finishExit();
  assert.equal(closed, 0);
  assert.ok(document.querySelector('[role="dialog"]'));
  await key('Escape');
  await finishExit();
  assert.equal(closed, 1);
});

test('Tab accepts the highlighted option without trapping keyboard focus', async () => {
  await render();
  document.getElementById('first').focus();
  await key('Enter');
  await key('End');
  const event = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  await act(async () => document.getElementById('first').dispatchEvent(event));
  assert.equal(event.defaultPrevented, false);
  assert.match(document.getElementById('first').textContent, /Delta/);
  assert.equal(document.getElementById('first').getAttribute('aria-expanded'), 'false');
  await finishExit();
});

test('reduced motion removes closing lists without a retained animation', async () => {
  window.matchMedia = () => ({ matches: true });
  await click('#first');
  await key('Escape');
  assert.equal(document.querySelector('[role="listbox"]'), null);
  window.matchMedia = () => ({ matches: false });
});

test('application UI enforces the canonical selector rule', () => {
  const offenders = [];
  const scan = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.tsx$/.test(path) && /<select(?:\s|>)/.test(readFileSync(path, 'utf8'))) offenders.push(path);
    }
  };
  scan('src');
  assert.deepEqual(offenders, []);
});
