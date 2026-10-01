import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const browser = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'MutationObserver', 'HTMLInputElement', 'HTMLTextAreaElement', 'InputEvent', 'Node', 'DOMParser']) globalThis[key] = browser.window[key];
Object.defineProperty(globalThis, 'navigator', { value: browser.window.navigator, configurable: true });
let clipboardText = '';
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { clipboardText = text; }, readText: async () => clipboardText } });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ClipboardEvent = window.Event;
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
window.matchMedia = () => ({ matches: false });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get() { return this.getAttribute('role') === 'menu' ? 240 : 0; } });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get() { return this.getAttribute('role') === 'menu' ? 180 : 0; } });
const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: "export * from './src/components/common/ContextMenu.tsx'; export * from './src/components/room/chat_message_actions.tsx'; export * from './src/core/text_editing.ts';", resolveDir: process.cwd() }, bundle: true,
  write: false, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, (args) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { ContextMenuProvider, useContextMenu, getChatMessageActions, captureTextEditing, registerTextEditor } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
let invoked = 0;
function Surface() {
  const open = useContextMenu();
  return React.createElement('div', null,
    React.createElement('div', { id: 'surface', tabIndex: 0, onContextMenu: (event) => open(event, [
      { id: 'first', label: 'First', onSelect: () => invoked++ },
      { id: 'disabled', label: 'Disabled', disabled: true, onSelect: () => invoked += 100 },
      { id: 'last', label: 'Last', onSelect: () => invoked += 10 },
    ]) }, React.createElement('video', { id: 'video' })),
    React.createElement('input', { id: 'editor' }),
    React.createElement('div', { className: 'modal-overlay', id: 'modal' }));
}
await act(async () => root.render(React.createElement(ContextMenuProvider, {
  getActions: () => [{ id: 'global', label: 'Global', onSelect: () => invoked++ }],
}, React.createElement(Surface))));
after(async () => { await act(async () => root.unmount()); browser.window.close(); });
const rightClick = async (id) => {
  const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1020, clientY: 760, button: 2 });
  await act(async () => document.getElementById(id).dispatchEvent(event));
  return event;
};
const key = async (value) => {
  await act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })));
};

test('right-click on media blocks native commands and never invokes playback actions', async () => {
  const event = await rightClick('video');
  assert.equal(event.defaultPrevented, true);
  assert.equal(invoked, 0);
  assert.equal(document.querySelectorAll('[role="menuitem"]').length, 3);
  assert.equal(document.activeElement.textContent, 'First');
  assert.equal(document.querySelector('[role="menu"]').style.left, '776px');
  assert.equal(document.querySelector('[role="menu"]').style.top, '580px');
});

test('keyboard skips disabled actions, runs the chosen action once and retains inert exit content', async () => {
  await key('ArrowDown');
  assert.equal(document.activeElement.textContent, 'Last');
  await key('Home');
  assert.equal(document.activeElement.textContent, 'First');
  await key('End');
  await act(async () => document.activeElement.click());
  assert.equal(invoked, 10);
  assert.equal(document.activeElement.id, 'surface');
  assert.equal(document.querySelector('[role="menu"]').hasAttribute('inert'), true);
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 280)));
  assert.equal(document.querySelector('[role="menu"]'), null);
});

test('Escape restores focus and outside clicks dismiss without running any action', async () => {
  await rightClick('video');
  await key('Escape');
  assert.equal(document.activeElement.id, 'surface');
  await rightClick('video');
  await act(async () => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
  assert.equal(document.querySelector('[role="menu"]').hasAttribute('inert'), true);
  assert.equal(invoked, 10);
});

test('editors use editing actions while modal backgrounds never expose room actions', async () => {
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 280)));
  assert.equal((await rightClick('editor')).defaultPrevented, true);
  assert.deepEqual(Array.from(document.querySelectorAll('[role="menuitem"]')).map((button) => button.textContent), ['Desfazer', 'Refazer', 'Recortar', 'Copiar', 'Colar', 'Excluir seleção', 'Selecionar tudo']);
  await key('Escape');
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 280)));
  assert.equal((await rightClick('modal')).defaultPrevented, true);
  assert.equal(document.querySelector('[role="menu"]'), null);
});

test('message actions respect authorship and attachment behavior', () => {
  const callbacks = { onReply() {}, onCopy() {}, onEdit() {}, onDelete() {}, onSaveAs() {} };
  const ids = (options) => getChatMessageActions({ ...callbacks, ...options }).map((action) => action.id);
  assert.deepEqual(ids({ own: false }), ['reply', 'copy']);
  assert.deepEqual(ids({ own: true }), ['reply', 'copy', 'edit', 'delete']);
  assert.deepEqual(ids({ own: false, isFile: true }), ['reply', 'save']);
  assert.deepEqual(ids({ own: true, isFile: true }), ['reply', 'delete']);
});

test('fullscreen menus stay inside the fullscreen surface and dismiss on scrolling', async () => {
  const surface = document.getElementById('surface');
  Object.defineProperty(document, 'fullscreenElement', { value: surface, configurable: true });
  await rightClick('video');
  assert.equal(document.querySelector('[role="menu"]').parentElement, surface);
  await act(async () => document.body.dispatchEvent(new window.Event('scroll')));
  assert.equal(document.querySelector('[role="menu"]').hasAttribute('inert'), true);
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 280)));
  Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
});


test('native inputs retain selection for copy, cut, paste and select-all', async () => {
  const field = document.getElementById('editor');
  field.value = 'before selected after';
  field.focus();
  field.setSelectionRange(7, 15);
  const secondaryDown = new window.MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true });
  field.dispatchEvent(secondaryDown);
  assert.equal(secondaryDown.defaultPrevented, true);
  await rightClick('editor');
  await act(async () => Array.from(document.querySelectorAll('[role="menuitem"]')).find((button) => button.textContent === 'Copiar').click());
  assert.equal(clipboardText, 'selected');
  assert.equal(field.value, 'before selected after');
  assert.equal(field.selectionStart, 7);
  await rightClick('editor');
  await act(async () => Array.from(document.querySelectorAll('[role="menuitem"]')).find((button) => button.textContent === 'Recortar').click());
  assert.equal(field.value, 'before  after');
  assert.equal(clipboardText, 'selected');
  clipboardText = 'replacement';
  await rightClick('editor');
  await act(async () => Array.from(document.querySelectorAll('[role="menuitem"]')).find((button) => button.textContent === 'Colar').click());
  assert.equal(field.value, 'before replacement after');
  await rightClick('editor');
  await act(async () => Array.from(document.querySelectorAll('[role="menuitem"]')).find((button) => button.textContent === 'Selecionar tudo').click());
  assert.equal(field.selectionStart, 0);
  assert.equal(field.selectionEnd, field.value.length);
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 280)));
});

test('read-only fields allow copying but reject mutation; stale snapshots reject writes', () => {
  const field = document.getElementById('editor');
  field.readOnly = true;
  field.setSelectionRange(0, 6);
  const session = captureTextEditing(field);
  assert.equal(session.editable, false);
  assert.equal(session.canCopy, true);
  session.insertText('bad');
  assert.equal(field.value, 'before replacement after');
  field.readOnly = false;
  const stale = captureTextEditing(field);
  field.value = 'changed';
  assert.throws(() => stale.insertText('bad'), /Editor changed/);
});

test('rich editor edits use Tiptap history and preserve the captured selection', async () => {
  const { Editor } = await import('@tiptap/core');
  const { default: StarterKit } = await import('@tiptap/starter-kit');
  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({ element, extensions: [StarterKit], content: '<p>before selected after</p>' });
  const unregister = registerTextEditor(editor);
  try {
    editor.commands.setTextSelection({ from: 8, to: 16 });
    const session = captureTextEditing(editor.view.dom);
    assert.equal(session.selectedText, 'selected');
    editor.commands.setTextSelection(1);
    session.deleteSelection();
    assert.equal(editor.getText(), 'before  after');
    const undo = captureTextEditing(editor.view.dom);
    assert.equal(undo.canUndo, true);
    undo.undo();
    assert.equal(editor.getText(), 'before selected after');
    const redo = captureTextEditing(editor.view.dom);
    assert.equal(redo.canRedo, true);
    redo.redo();
    assert.equal(editor.getText(), 'before  after');
    captureTextEditing(editor.view.dom).insertText('replacement');
    assert.equal(editor.getText(), 'before replacement after');
    captureTextEditing(editor.view.dom).selectAll();
    assert.equal(editor.state.selection.from, 0);
    assert.equal(editor.state.selection.to, editor.state.doc.content.size);
  } finally { unregister(); editor.destroy(); element.remove(); }
});
