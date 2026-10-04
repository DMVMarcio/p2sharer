import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { AppUpdateController } from '../../src/core/app_updates.ts';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'localStorage']) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = window.getComputedStyle;
HTMLElement.prototype.scrollIntoView = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: { contents: `export { ApplicationSettings } from './src/components/modals/ApplicationSettings.tsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
  plugins: [{ name: 'updater-fixture', setup(builder) {
    builder.onResolve({ filter: /services\/app_updates/ }, () => ({ path: 'updater', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
      contents: 'export const appUpdates = globalThis.applicationSettingsController;',
    }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
// The component reads the real controller through its normal subscription hook.
const channels = [];
const controller = new AppUpdateController({
  check: async preview => { channels.push(preview); return null; },
  prepareInstall: async () => {}, restart: async () => {},
});
controller.setPreferences(false, false);
globalThis.applicationSettingsController = controller;
const { ApplicationSettings } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
function Harness() {
  const [automatic, setAutomatic] = useState(false);
  const [preview, setPreview] = useState(false);
  return React.createElement(React.Fragment, null,
    React.createElement(ApplicationSettings, { automatic, includePrereleases: preview,
      onAutomaticChange: setAutomatic, onPrereleasesChange: setPreview }),
    React.createElement('button', { id: 'save', onClick: () => controller.setPreferences(automatic, preview) }, 'Save'));
}
after(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  delete globalThis.applicationSettingsController;
});

test('application update controls keep drafts unsaved and check only the saved channel', async () => {
  await act(async () => root.render(React.createElement(Harness)));
  assert.equal(document.querySelector('h3').textContent, 'Aplicação');
  const preview = document.getElementById('settings-beta-updates');
  const check = document.querySelector('#settings-pane-application .btn-secondary');
  assert.equal(preview.checked, false);
  assert.equal(check.disabled, false);
  await act(async () => preview.click());
  assert.equal(preview.checked, true);
  assert.equal(controller.getSnapshot().includePrereleases, false);
  assert.equal(check.disabled, true);
  await act(async () => document.getElementById('save').click());
  assert.equal(controller.getSnapshot().includePrereleases, true);
  assert.equal(check.disabled, false);
  await act(async () => check.click());
  assert.deepEqual(channels, [true]);
  assert.equal(controller.getSnapshot().dialogOpen, true);
});

test('the canonical language selector applies and persists English immediately without resetting settings drafts', async () => {
  const selector = document.getElementById('settings-language');
  assert.equal(selector.getAttribute('role'), 'combobox');
  await act(async () => selector.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  assert.deepEqual([...document.querySelectorAll('[role="option"]')].map(option => option.textContent), ['English', 'Português Brasil']);
  await act(async () => selector.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(document.querySelector('h3').textContent, 'Application');
  assert.equal(localStorage.getItem('p2sharer_language'), 'en');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(document.getElementById('settings-beta-updates').checked, true);
  assert.equal(document.getElementById('settings-language'), selector);
});
