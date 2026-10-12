import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act, useEffect } from 'react';

test('content swaps retain inert outgoing views, cancel obsolete destinations, and honor reduced motion', async context => {
  const require = createRequire(import.meta.url);
  const bundle = await build({
    stdin: { contents: "export { ContentTransition } from './src/components/common/ContentTransition';",
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
    plugins: [{ name: 'shared-react', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }],
  });
  const { ContentTransition } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys.slice(0, -1)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const listeners = new Set();
  const motion = { matches: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  window.matchMedia = () => motion;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  window.setTimeout = (fn, ms) => setTimeout(fn, ms);
  window.clearTimeout = timer => clearTimeout(timer);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const mounted = [], removed = [];
  const Pane = ({ value }) => {
    useEffect(() => { mounted.push(value); return () => { removed.push(value); }; }, []);
    return React.createElement('button', null, value);
  };
  const render = value => act(async () => root.render(React.createElement(ContentTransition,
    { value }, displayed => React.createElement(Pane, { value: displayed }))));
  const text = () => document.querySelector('#root button')?.textContent;
  const inert = () => document.querySelector('#root > div').hasAttribute('inert');
  try {
    await render('home');
    await render('room');
    assert.equal(text(), 'home'); assert.equal(inert(), true);
    assert.deepEqual(removed, []);
    await act(async () => context.mock.timers.tick(60));
    await render('settings');
    await act(async () => context.mock.timers.tick(149));
    assert.equal(text(), 'home');
    await act(async () => context.mock.timers.tick(1));
    assert.equal(text(), 'settings'); assert.equal(inert(), false);
    assert.deepEqual(mounted, ['home', 'settings']);
    assert.deepEqual(removed, ['home']);
    await render('room');
    await render('settings');
    await act(async () => context.mock.timers.tick(200));
    assert.equal(text(), 'settings'); assert.equal(inert(), false);
    await render('room');
    await act(async () => { motion.matches = true; for (const fn of [...listeners]) fn(); });
    assert.equal(text(), 'room'); assert.equal(inert(), false);
    await render('home');
    assert.equal(text(), 'home', 'reduced motion commits immediately');
    await act(async () => { motion.matches = false; });
    await render('room');
    await act(async () => root.unmount());
    await act(async () => context.mock.timers.tick(1000));
    assert.equal(listeners.size, 0);
    assert.equal(document.querySelector('#root').children.length, 0);
  } finally {
    await act(async () => root.unmount());
    context.mock.timers.reset(); dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
