import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

test('toast exits retain inert content, stack moves, and reduced motion removes immediately', async context => {
  const require = createRequire(import.meta.url);
  const bundle = await build({
    stdin: { contents: "export { useToastStack } from './src/hooks/useToastStack';",
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
    plugins: [{ name: 'shared-react', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }],
  });
  const { useToastStack } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys.slice(0, 4)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const listeners = new Set();
  const motion = { matches: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  window.matchMedia = () => motion;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  window.setTimeout = (fn, ms) => setTimeout(fn, ms);
  window.clearTimeout = timer => clearTimeout(timer);
  const movements = [];
  const animations = [];
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const siblings = [...this.parentElement.children];
    return { top: 1000 - siblings.length * 80 + siblings.indexOf(this) * 80 };
  };
  dom.window.HTMLElement.prototype.animate = function (frames) {
    movements.push({ id: this.dataset.id, frames });
    const animation = { cancel: () => { animation.cancelled = true; }, cancelled: false };
    animations.push(animation);
    return animation;
  };
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const Stack = ({ toasts }) => {
    const { items, refFor } = useToastStack(toasts);
    return React.createElement('div', null, items.map(item => React.createElement('div', {
      key: item.id, ref: refFor(item.id), 'data-id': item.id, inert: item.exiting,
    }, item.message)));
  };
  const toast = id => ({ id, message: id, type: 'info', durationMs: 1000, paused: false });
  const first = toast('first'), second = toast('second');
  const render = toasts => act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Stack, { toasts }))));
  const row = id => document.querySelector(`[data-id="${id}"]`);
  try {
    await render([first]);
    await render([first, second]);
    assert.ok(movements.some(move => move.id === first.id));
    const moving = animations.at(-1);
    await render([{ ...first, paused: true }, second]);
    assert.equal(moving.cancelled, false, 'pausing does not cancel ongoing stack movement');
    await render([second]);
    assert.ok(row('first').hasAttribute('inert'));
    assert.ok(row('second'));
    await act(async () => context.mock.timers.tick(1000));
    assert.equal(row('first'), null);
    await render([first, second]);
    await render([first]);
    assert.ok(row('second').hasAttribute('inert'));
    await act(async () => { motion.matches = true; listeners.forEach(fn => fn()); });
    assert.equal(row('second'), null);
    const count = movements.length;
    await render([]);
    assert.equal(row('first'), null);
    assert.equal(movements.length, count);
    await act(async () => { motion.matches = false; listeners.forEach(fn => fn()); });
    await render([first, second]);
    await render([second]);
    assert.ok(row('first').hasAttribute('inert'));
    await act(async () => root.unmount());
    assert.equal(listeners.size, 0);
    assert.ok(animations.every(animation => animation.cancelled));
    await act(async () => context.mock.timers.tick(1000));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
