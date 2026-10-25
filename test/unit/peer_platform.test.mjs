import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `
      export { getLocalPlatform } from './src/core/platform.ts';
      export { PeerTracker } from './src/p2p/peer_tracker.ts';
      export { PlatformBadge } from './src/components/common/PlatformBadge.tsx';
    `,
    resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  plugins: [
    {
      name: 'fixtures',
      setup(builder) {
        builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'tauri-core', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: 'export const isTauri = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);',
          loader: 'js',
        }));
        builder.onResolve({ filter: /^[^./]/ }, args => ({
          path: pathToFileURL(require.resolve(args.path)).href,
          external: true,
        }));
      },
    },
  ],
});

const { getLocalPlatform, PeerTracker, PlatformBadge } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

test('getLocalPlatform distinguishes desktop, mobile and web runtimes', () => {
  const origWindow = globalThis.window;
  const origNavigator = globalThis.navigator;

  try {
    // 1. Desktop runtime (__TAURI_INTERNALS__)
    globalThis.window = { __TAURI_INTERNALS__: {} };
    assert.equal(getLocalPlatform(), 'desktop');

    // 2. Mobile web runtime
    globalThis.window = {};
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
    });
    assert.equal(getLocalPlatform(), 'mobile');

    // 3. Desktop web runtime
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    assert.equal(getLocalPlatform(), 'web');
  } finally {
    globalThis.window = origWindow;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: origNavigator,
    });
  }
});

test('PeerTracker records, persists, and purges peer platform information', () => {
  const tracker = new PeerTracker();

  // Direct peer on web
  tracker.receivePeerExchange('p-web', true, 'Alice', false, Date.now(), 'web');
  assert.equal(tracker.getPlatform('p-web'), 'web');
  const peers = tracker.getAllRoomPeers();
  const alice = peers.find(p => p.id === 'p-web');
  assert.ok(alice);
  assert.equal(alice.platform, 'web');

  // Direct peer on mobile via addPeer
  tracker.addPeer('p-mobile', 'Bob', false, Date.now(), 'mobile');
  assert.equal(tracker.getPlatform('p-mobile'), 'mobile');
  const bob = tracker.getAllRoomPeers().find(p => p.id === 'p-mobile');
  assert.ok(bob);
  assert.equal(bob.platform, 'mobile');

  // Direct peer with default/unspecified platform defaults to desktop
  tracker.addPeer('p-legacy', 'Charlie', false, Date.now());
  assert.equal(tracker.getPlatform('p-legacy'), undefined);
  const charlie = tracker.getAllRoomPeers().find(p => p.id === 'p-legacy');
  assert.ok(charlie);
  assert.equal(charlie.platform, 'desktop');

  // Disconnection cleans up platform
  tracker.removePeer('p-web');
  assert.equal(tracker.getPlatform('p-web'), undefined);
  assert.ok(!tracker.getAllRoomPeers().some(p => p.id === 'p-web'));

  // Clear cleans up all
  tracker.clear();
  assert.equal(tracker.getPlatform('p-mobile'), undefined);
  assert.equal(tracker.getAllRoomPeers().length, 0);
});

test('PlatformBadge renders accessible icon and tooltip for platforms', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
    url: 'https://example.test',
  });
  const origWindow = globalThis.window;
  const origDocument = globalThis.document;
  const origHTMLElement = globalThis.HTMLElement;
  const origIS_REACT_ACT_ENVIRONMENT = globalThis.IS_REACT_ACT_ENVIRONMENT;

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        React.createElement('div', null, [
          React.createElement(PlatformBadge, { key: 'desktop', platform: 'desktop' }),
          React.createElement(PlatformBadge, { key: 'web', platform: 'web' }),
          React.createElement(PlatformBadge, { key: 'mobile', platform: 'mobile' }),
        ])
      );
    });

    const badges = container.querySelectorAll('.platform-badge');
    assert.equal(badges.length, 3);
    assert.equal(badges[0].getAttribute('role'), 'img');
    assert.ok(badges[0].getAttribute('aria-label'));
    assert.ok(badges[1].getAttribute('aria-label'));
    assert.ok(badges[2].getAttribute('aria-label'));

    // Check SVG icons are rendered inside each badge
    assert.ok(badges[0].querySelector('svg'));
    assert.ok(badges[1].querySelector('svg'));
    assert.ok(badges[2].querySelector('svg'));
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
    globalThis.window = origWindow;
    globalThis.document = origDocument;
    globalThis.HTMLElement = origHTMLElement;
    globalThis.IS_REACT_ACT_ENVIRONMENT = origIS_REACT_ACT_ENVIRONMENT;
  }
});
