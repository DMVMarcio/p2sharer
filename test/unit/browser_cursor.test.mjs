import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

test('local cursor follows the latest display frame without changing authority and retires on handoff or tab changes', async context => {
  const require = createRequire(import.meta.url);
  const bundle = await build({ stdin: { contents: "export { useBrowserCursor } from './src/hooks/useBrowserCursor';", resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'shared-react', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }] });
  const { useBrowserCursor } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys.slice(0, 5)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  let frame; globalThis.requestAnimationFrame = callback => { frame = callback; return 1; };
  globalThis.cancelAnimationFrame = () => { frame = undefined; };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(document.getElementById('root'));
  let cursor;
  const authoritative = { x: 10, y: 10, actor: 'alice' };
  const Harness = ({ allowed = true, tab = 1 }) => {
    cursor = useBrowserCursor(authoritative, allowed, 'alice', tab);
    return React.createElement('span', null, cursor.pointer?.x);
  };
  const render = props => act(async () => root.render(React.createElement(Harness, props)));
  try {
    await render({});
    await act(async () => { cursor.preview({ x: 20, y: 20 }); cursor.preview({ x: 30, y: 30 }); });
    assert.equal(cursor.pointer.x, 10);
    await act(async () => frame());
    assert.equal(cursor.pointer.x, 30); assert.equal(authoritative.x, 10);
    await render({}); assert.equal(cursor.pointer.x, 30, 'an older acknowledgement cannot rewind the local visual');
    await act(async () => cursor.leave());
    assert.equal(cursor.pointer, null, 'leaving immediately suppresses the last authoritative local pointer');
    await render({}); assert.equal(cursor.pointer, null);
    await act(async () => { cursor.preview({ x: 30, y: 30 }); frame(); });
    await render({ allowed: false }); assert.equal(cursor.pointer.x, 10); assert.equal(cursor.predicted, false);
    await render({}); await act(async () => { cursor.preview({ x: 40, y: 40 }); frame(); });
    await render({ tab: 2 }); assert.equal(cursor.pointer.x, 10);
    await act(async () => { cursor.preview({ x: 50, y: 50 }); frame(); });
    await act(async () => context.mock.timers.tick(1001)); assert.equal(cursor.predicted, false);
  } finally {
    await act(async () => root.unmount()); context.mock.timers.reset(); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
