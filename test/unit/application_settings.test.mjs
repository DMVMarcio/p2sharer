import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { AppUpdateController } from '../../src/core/app_updates.ts';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event', 'CustomEvent', 'localStorage']) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = window.getComputedStyle;
HTMLElement.prototype.scrollIntoView = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: { contents: `export { ApplicationSettings } from './src/components/modals/ApplicationSettings.tsx';
    export { SettingsModal } from './src/components/modals/SettingsModal.tsx';
    export { getLanguage, setLanguage } from './src/i18n/index.ts';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
  plugins: [{ name: 'updater-fixture', setup(builder) {
    builder.onResolve({ filter: /room_service|useModal|@tauri-apps\/api\/core/ }, args => ({
      path: args.path.includes('room_service') ? 'room' : args.path.includes('useModal') ? 'modal' : 'native', namespace: 'settings-fixture',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'settings-fixture' }, args => ({ contents: {
      room: 'export const roomService = { refreshStreamPointerPermissions() {} };',
      modal: 'export const useModal = () => ({ isClosing: false, closeModal: () => globalThis.settingsClosed++ });',
      native: 'export const invoke = async command => command === "get_log_file_path" ? "fixture.log" : { driver_api_available: false };',
    }[args.path] }));
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
const { ApplicationSettings, SettingsModal, getLanguage, setLanguage } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=application-settings-test.js').toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
function Harness() {
  const [automatic, setAutomatic] = useState(false);
  const [preview, setPreview] = useState(false);
  const [language, setLanguageDraft] = useState(getLanguage);
  return React.createElement(React.Fragment, null,
    React.createElement(ApplicationSettings, { language, onLanguageChange: setLanguageDraft, automatic, includePrereleases: preview,
      onAutomaticChange: setAutomatic, onPrereleasesChange: setPreview }),
    React.createElement('button', { id: 'save', onClick: () => { controller.setPreferences(automatic, preview); setLanguage(language); } }, 'Save'));
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

test('the canonical language selector keeps its choice as an unsaved draft', async () => {
  const selector = document.getElementById('settings-language');
  assert.equal(selector.getAttribute('role'), 'combobox');
  await act(async () => selector.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  assert.deepEqual([...document.querySelectorAll('[role="option"]')].map(option => option.textContent), ['English', 'Português Brasil']);
  await act(async () => selector.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(document.querySelector('h3').textContent, 'Aplicação');
  assert.equal(getLanguage(), 'pt-BR');
  assert.equal(localStorage.getItem('p2sharer_language'), 'pt-BR');
  assert.equal(document.querySelector('#settings-language + .field-info-text'), null);
  await act(async () => document.getElementById('save').click());
  assert.equal(document.querySelector('h3').textContent, 'Application');
  assert.equal(localStorage.getItem('p2sharer_language'), 'en');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(document.getElementById('settings-beta-updates').checked, true);
  assert.equal(document.getElementById('settings-language'), selector);
});

test('the actual settings modal discards a closed language draft and applies it only on Save Settings', async () => {
  await act(async () => { root.render(null); setLanguage('pt-BR'); });
  globalThis.settingsClosed = 0;
  async function open() {
    await act(async () => root.render(React.createElement(SettingsModal)));
    await act(async () => document.querySelector('.settings-nav-sidebar button:last-child').click());
  }
  async function chooseEnglish() {
    const selector = document.getElementById('settings-language');
    await act(async () => selector.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    await act(async () => selector.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  }
  await open(); await chooseEnglish();
  assert.equal(getLanguage(), 'pt-BR');
  assert.equal(localStorage.getItem('p2sharer_language'), 'pt-BR');
  await act(async () => document.getElementById('btn-cancel-settings').click());
  assert.equal(globalThis.settingsClosed, 1);
  await act(async () => root.render(null));
  await open();
  assert.equal(document.getElementById('settings-language').textContent.trim(), 'Português Brasil');
  await chooseEnglish();
  await act(async () => document.getElementById('btn-save-settings').click());
  assert.equal(globalThis.settingsClosed, 2);
  assert.equal(getLanguage(), 'en');
  assert.equal(localStorage.getItem('p2sharer_language'), 'en');
  assert.equal(document.documentElement.lang, 'en');
  delete globalThis.settingsClosed;
});
