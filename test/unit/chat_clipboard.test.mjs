import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act, useRef } from 'react';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'DOMParser', 'FileReader']) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fixture = globalThis.clipboardFixture = { calls: [] };
const bundle = await build({ stdin: { contents: "export { useChatFileInput } from './src/hooks/useChatFileInput.ts';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', plugins: [{ name: 'clipboard-native-fixture', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/(core|webview)$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'fixture' }));
    builder.onResolve({ filter: /useToast$/ }, () => ({ path: 'toast', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'core' ? `
      export const isTauri = () => true;
      export const invoke = async (command, args) => { globalThis.clipboardFixture.calls.push({ command, args });
        return command === 'paste_chat_files' ? [{ id: 'clipboard', name: 'clipboard.gif', isImage: true }] : null; };
    ` : args.path === 'webview' ? 'export const getCurrentWebview = () => ({ onDragDropEvent: async () => () => {} });' : 'export const showToast = () => {};' }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
  } }] });
const { useChatFileInput } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
let input;
function Fixture() { const ref = useRef(null); input = useChatFileInput(ref); return React.createElement('div', { ref, id: 'chat', tabIndex: 0 }); }
await act(async () => root.render(React.createElement(Fixture)));
const chat = document.getElementById('chat'); chat.getClientRects = () => [{}];
const paste = async (files, html = '') => {
  const event = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, getData: type => type === 'text/html' ? html : '' } });
  await act(async () => { chat.dispatchEvent(event); await new Promise(resolve => setTimeout(resolve, 80)); });
  return event;
};
const clear = async () => { await act(async () => { input.markOffered(); input.close(); }); fixture.calls.length = 0; };
after(async () => { await act(async () => root.unmount()); dom.window.close(); delete globalThis.clipboardFixture; });

test('pasting original GIF bytes preserves their encoded form and cancels the keyboard fallback', async () => {
  await act(async () => chat.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true })));
  const gif = new window.File(['GIF89a-original-animation'], 'image.gif', { type: 'image/gif' });
  assert.equal((await paste([gif])).defaultPrevented, true);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].command, 'paste_chat_files');
  assert.equal(fixture.calls[0].args.gifSource, `data:image/gif;base64,${Buffer.from('GIF89a-original-animation').toString('base64')}`);
  await clear();
});

test('a copied GIF origin takes precedence over its PNG clipboard rendition while plain text remains editable', async () => {
  const png = new window.File(['static'], 'image.png', { type: 'image/png' });
  await paste([png], '<img src="https://example.com/animated.gif?size=original">');
  assert.equal(fixture.calls[0].args.gifSource, 'https://example.com/animated.gif?size=original');
  await clear();
  assert.equal((await paste([])).defaultPrevented, false);
  assert.equal(fixture.calls.length, 0);
});
