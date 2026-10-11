import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

test('clipboard feedback follows successful writes, resets, and ignores obsolete writes', async (context) => {
  const require = createRequire(import.meta.url);
  const bundle = await build({
    stdin: { contents: "export { useClipboardFeedback } from './src/hooks/useClipboardFeedback';",
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'shared-react', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }],
  });
  const { useClipboardFeedback } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys.slice(0, -1)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let write = async () => {};
  const writes = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: value => { writes.push(value); return write(); } } });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const Harness = ({ value }) => {
    const { copied, copy } = useClipboardFeedback(value, 100);
    return React.createElement('button', { onClick: copy, 'data-copied': copied }, 'Copy');
  };
  const render = value => act(async () => root.render(React.createElement(Harness, { value })));
  const button = () => document.querySelector('button');
  const copied = () => button().dataset.copied === 'true';
  try {
    await render('first invitation');
    assert.equal(copied(), false);
    await act(async () => button().click());
    assert.deepEqual(writes, ['first invitation']);
    assert.equal(copied(), true);
    await act(async () => context.mock.timers.tick(75));
    await act(async () => button().click());
    await act(async () => context.mock.timers.tick(75));
    assert.equal(copied(), true, 'a repeated successful write renews feedback');
    await act(async () => context.mock.timers.tick(25));
    assert.equal(copied(), false);

    await act(async () => button().click());
    assert.equal(copied(), true);
    await render('another invitation');
    assert.equal(copied(), false, 'changing the invitation clears previous feedback');

    write = async () => { throw new Error('Clipboard unavailable'); };
    await act(async () => button().click());
    assert.equal(copied(), false, 'a failed write never reports success');
    let finish;
    write = () => new Promise(resolve => { finish = resolve; });
    await act(async () => button().click());
    await render('replacement invitation');
    await act(async () => finish());
    assert.equal(copied(), false, 'completion from a previous room cannot acknowledge the current room');
    await act(async () => button().click());
    await act(async () => root.unmount());
    await act(async () => finish());
    await act(async () => context.mock.timers.tick(100));
  } finally {
    await act(async () => root.unmount());
    context.mock.timers.reset();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
