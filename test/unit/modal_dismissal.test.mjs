import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

test('shared dialogs trap focus, protect busy work and drafts, and dismiss child menus before their parent', async () => {
  const require = createRequire(import.meta.url);
  const bundle = await build({
    stdin: { contents: "export { useModalDialogBehavior } from './src/components/common/useModalDialogBehavior';",
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'shared-react', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }],
  });
  const { useModalDialogBehavior } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const dom = new JSDOM('<button id="launcher">Open</button><div id="root"></div>');
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys.slice(0, -1)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  let closed = 0;
  const Harness = ({ busy = false, outside = false, child = false }) => {
    const ref = useModalDialogBehavior(() => closed++, busy, outside);
    return React.createElement('div', { className: 'overlay' },
      React.createElement('div', { ref }, React.createElement('h2', null, 'Dialog'),
        React.createElement('button', { id: 'first' }, 'First'), React.createElement('button', { id: 'last' }, 'Last')),
      child && React.createElement(Child));
  };
  const Child = () => {
    const ref = useModalDialogBehavior(() => closed += 10);
    return React.createElement('div', { ref }, React.createElement('h2', null, 'Child'), React.createElement('button', null, 'Close child'));
  };
  const render = props => act(async () => root.render(React.createElement(Harness, props)));
  const key = (value, shiftKey = false) => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, shiftKey }));
  const outside = () => document.querySelector('.overlay').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  try {
    document.getElementById('launcher').focus();
    await render({});
    assert.equal(document.activeElement.id, 'first');
    key('Tab', true);
    assert.equal(document.activeElement.id, 'last');
    key('Tab');
    assert.equal(document.activeElement.id, 'first');
    outside();
    assert.equal(closed, 0);
    await render({ busy: true, outside: true });
    key('Escape'); outside();
    assert.equal(closed, 0);
    await render({ outside: true });
    outside();
    assert.equal(closed, 1);
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); document.body.append(menu);
    key('Escape');
    assert.equal(closed, 1);
    menu.remove();
    key('Escape');
    assert.equal(closed, 2);
    await render({ child: true });
    key('Escape');
    assert.equal(closed, 12, 'Escape belongs to the top child dialog');
    await render({});
    key('Escape');
    assert.equal(closed, 13);
    await act(async () => root.unmount());
    assert.equal(document.activeElement.id, 'launcher');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
