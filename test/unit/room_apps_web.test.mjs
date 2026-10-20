import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

test('AppsModal renders all apps on web with desktop-only apps disabled and showing notice', async () => {
  const require = createRequire(import.meta.url);
  const bundle = await build({
    stdin: {
      contents: `
        export { AppsModal } from './src/components/modals/AppsModal.tsx';
        export { listRoomApps } from './src/apps/registry.ts';
        export { t } from './src/i18n/index.ts';
      `,
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    plugins: [{
      name: 'fixtures',
      setup(builder) {
        builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'core', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: 'export class Channel {} export const isTauri = () => globalThis.__isTauri === true; export const invoke = async () => {};',
          loader: 'js',
        }));
        builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
      },
    }],
  });

  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test' });
  const keys = ['window', 'document', 'navigator', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT', '__isTauri'];
  for (const key of keys.slice(0, 4)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const { AppsModal, listRoomApps, t } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

  try {
    // 1. Web environment: __isTauri = false
    globalThis.__isTauri = false;
    await act(async () => root.render(React.createElement(AppsModal)));

    const cards = Array.from(document.querySelectorAll('.apps-library-card'));
    assert.equal(cards.length, listRoomApps().length, 'All room apps must appear in web version');

    const noticeText = t('apps.desktopOnlyNotice');
    assert.ok(noticeText && noticeText.length > 0);

    const desktopKinds = ['tunnels', 'browser'];
    const webKinds = ['notepad', 'youtube', 'whiteboard'];

    for (const app of listRoomApps()) {
      const card = cards.find(c => c.querySelector('h3')?.textContent === app.label);
      assert.ok(card, `Card for ${app.kind} exists`);

      if (desktopKinds.includes(app.kind)) {
        assert.equal(card.disabled, true, `${app.kind} must be disabled on web`);
        assert.ok(card.classList.contains('is-disabled'), `${app.kind} card must have is-disabled class`);
        const notice = card.querySelector('.apps-library-card-notice');
        assert.ok(notice, `${app.kind} must display the desktop notice`);
        assert.equal(notice.textContent?.trim(), noticeText);

        // Clicking disabled card should not select it
        await act(async () => card.click());
        assert.equal(card.classList.contains('selected'), false);
      } else {
        assert.equal(card.disabled, false, `${app.kind} must be enabled on web`);
        assert.equal(card.classList.contains('is-disabled'), false);
        assert.equal(card.querySelector('.apps-library-card-notice'), null);
      }
    }

    const startBtn = document.querySelector('.apps-library-start');
    assert.ok(startBtn);
    assert.equal(startBtn.disabled, true, 'Start button remains disabled when no valid app is selected');

    // Select an allowed app (e.g. notepad)
    const notepadCard = cards.find(c => c.querySelector('h3')?.textContent === listRoomApps().find(a => a.kind === 'notepad')?.label);
    assert.ok(notepadCard);
    await act(async () => notepadCard.click());
    assert.ok(notepadCard.classList.contains('selected'));
    assert.equal(startBtn.disabled, false, 'Start button enabled when allowed app is selected');

    // 2. Desktop environment: __isTauri = true
    globalThis.__isTauri = true;
    await act(async () => root.render(React.createElement(AppsModal)));

    const desktopCards = Array.from(document.querySelectorAll('.apps-library-card'));
    for (const card of desktopCards) {
      assert.equal(card.disabled, false, 'All cards enabled on desktop');
      assert.equal(card.classList.contains('is-disabled'), false);
      assert.equal(card.querySelector('.apps-library-card-notice'), null);
    }
  } finally {
    await act(async () => root.render(null));
    for (const key of keys) delete globalThis[key];
  }
});
