import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { ReleaseNotesController } from '../../src/core/release_notes.ts';
import { AppUpdateController } from '../../src/core/app_updates.ts';

test('unread notes wait for other dialogs, survive interrupted viewing and acknowledge only on dismissal', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals.slice(0, -1)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('p2sharer_username', 'Existing profile');
  const fixture = globalThis.releaseNotesFixture = {
    notes: new ReleaseNotesController('1.4.1', localStorage), active: 'username',
    update: new AppUpdateController({ check: async () => null, prepareInstall: async () => {}, restart: async () => {} }),
  };
  let root;
  try {
    const require = createRequire(import.meta.url);
    const bundle = await build({ stdin: { contents: "export { ReleaseNotesDialog } from './src/components/modals/ReleaseNotesDialog.tsx';",
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
      write: false, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
      plugins: [{ name: 'notes-boundaries', setup(builder) {
        builder.onResolve({ filter: /services\/release_notes$|services\/app_updates$|hooks\/useModal$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: {
          release_notes: `export const releaseNotes = globalThis.releaseNotesFixture.notes;
            export const installedReleaseNotes = () => ['**Files** with *improvements* and ~~old behavior~~.\\n\\n## Highlights\\n\\n- Paste images\\n- Share files\\n\\n<img src="https://example.invalid/image">\\n\\n![Image](https://example.invalid/image) [Details](https://example.invalid/notes) <script>alert(1)</script>'];`,
          app_updates: 'export const appUpdates = globalThis.releaseNotesFixture.update;',
          useModal: 'export const useModal = () => ({ activeModal: globalThis.releaseNotesFixture.active });',
        }[args.path] }));
        builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
      } }] });
    const { ReleaseNotesDialog } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
    const { createRoot } = await import('react-dom/client');
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(ReleaseNotesDialog)));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    fixture.active = null;
    await act(async () => root.render(React.createElement(ReleaseNotesDialog, { blocked: true })));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => fixture.update.open());
    await act(async () => root.render(React.createElement(ReleaseNotesDialog)));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => fixture.update.close());
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.equal(document.querySelector('.release-notes-list img'), null);
    assert.equal(document.querySelector('.release-notes-list strong').textContent, 'Files');
    assert.equal(document.querySelector('.release-notes-list em').textContent, 'improvements');
    assert.equal(document.querySelector('.release-notes-list del').textContent, 'old behavior');
    assert.equal(document.querySelector('.release-notes-list h2').textContent, 'Highlights');
    assert.equal(document.querySelectorAll('.release-notes-list ul li').length, 2);
    assert.equal(document.querySelector('.release-notes-list a'), null);
    assert.equal(document.querySelector('.release-notes-list script'), null);
    assert.match(document.querySelector('.release-notes-list').textContent, /Details/);
    await act(async () => root.render(null));
    assert.equal(new ReleaseNotesController('1.4.1', localStorage).getSnapshot().pending, true);
    await act(async () => root.render(React.createElement(ReleaseNotesDialog)));
    await act(async () => document.querySelector('.modal-footer button').click());
    await act(async () => new Promise(resolve => setTimeout(resolve, 260)));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(new ReleaseNotesController('1.4.1', localStorage).getSnapshot().pending, false);
  } finally {
    if (root) await act(async () => root.unmount());
    delete globalThis.releaseNotesFixture;
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
