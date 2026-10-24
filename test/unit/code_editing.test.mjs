import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'DOMParser', 'MutationObserver', 'localStorage', 'Event', 'CustomEvent', 'KeyboardEvent'])
  globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
HTMLElement.prototype.scrollIntoView = () => {};

const bundle = await build({ stdin: { contents: `
  export { CodeBlockExtension } from './src/components/common/CodeBlockExtension.tsx';
  export { CodeEditing } from './src/components/common/CodeEditing.ts';
  export { EmojiComposerInput } from './src/components/common/EmojiComposerInput.tsx';
  export { ChatMessageContent } from './src/components/common/ChatMessageContent.tsx';
  export { setLanguage } from './src/i18n/index.ts';
`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic',
  plugins: [{ name: 'code-editor-fixture', setup(builder) {
    const mocks = {
      useTextEditorContextMenu: 'export const useTextEditorContextMenu = () => {};',
      room_service: 'export const roomService = { peers: [], chatMessages: [] };',
      state_store: 'export const stateStore = { username: "Fixture", roomSlots: [] };',
      profile_image: 'export const profileImages = { color: () => "#123456" };',
      useModal: 'export const modalManager = { openProfile() {}, openExternalLink() {} };',
    };
    builder.onResolve({ filter: /\/(useTextEditorContextMenu|room_service|state_store|profile_image|useModal)$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path] }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
  } }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
api.setLanguage('en');
const { Editor } = await import('@tiptap/core');
const { EditorContent } = await import('@tiptap/react');
const { default: StarterKit } = await import('@tiptap/starter-kit');
const { Markdown } = await import('@tiptap/markdown');
const { TableKit } = await import('@tiptap/extension-table');
const { closeHistory } = await import('@tiptap/pm/history');
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
const extensions = () => [StarterKit.configure({ codeBlock: false }), api.CodeBlockExtension, api.CodeEditing.configure({ plainTextTab: true }), Markdown, TableKit];
const setCode = (editor, text, from = 0, to = from) => {
  editor.commands.setContent({ type: 'doc', content: [{ type: 'codeBlock', attrs: { language: 'javascript' },
    content: text ? [{ type: 'text', text }] : [] }] });
  editor.commands.setTextSelection({ from: from + 1, to: to + 1 });
  editor.view.dispatch(closeHistory(editor.state.tr));
};
const key = (editor, shortcut) => editor.view.dom.dispatchEvent(new window.KeyboardEvent('keydown', {
  key: shortcut.split('-').pop(), ctrlKey: shortcut.includes('Mod-'), altKey: shortcut.includes('Alt-'),
  shiftKey: shortcut.includes('Shift-'), bubbles: true, cancelable: true,
}));

after(async () => { await act(async () => root.unmount()); dom.window.close(); });

test('code line shortcuts preserve selection, indent complete lines, move, duplicate, comment and undo', () => {
  const editor = new Editor({ extensions: extensions() });
  try {
    setCode(editor, 'alpha\nbeta\ngamma', 2, 12);
    key(editor, 'Tab');
    assert.equal(editor.state.doc.firstChild.textContent, '  alpha\n  beta\n  gamma');
    assert.equal(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to), 'pha\n  beta\n  g');
    key(editor, 'Shift-Tab');
    assert.equal(editor.state.doc.firstChild.textContent, 'alpha\nbeta\ngamma');
    assert.equal(editor.state.selection.from, 3);
    assert.equal(editor.state.selection.to, 13);
    setCode(editor, 'first\nsecond\nthird', 7);
    key(editor, 'Alt-ArrowUp');
    assert.equal(editor.state.doc.firstChild.textContent, 'second\nfirst\nthird');
    assert.equal(editor.state.selection.from, 2);
    key(editor, 'Alt-ArrowDown');
    assert.equal(editor.state.doc.firstChild.textContent, 'first\nsecond\nthird');
    key(editor, 'Alt-Shift-ArrowDown');
    assert.equal(editor.state.doc.firstChild.textContent, 'first\nsecond\nsecond\nthird');
    key(editor, 'Mod-/');
    assert.equal(editor.state.doc.firstChild.textContent, 'first\nsecond\n// second\nthird');
    key(editor, 'Mod-/');
    assert.equal(editor.state.doc.firstChild.textContent, 'first\nsecond\nsecond\nthird');
    setCode(editor, 'value', 2);
    key(editor, 'Tab');
    assert.equal(editor.state.doc.firstChild.textContent, 'va  lue');
    key(editor, 'Mod-z');
    assert.equal(editor.state.doc.firstChild.textContent, 'value');
    key(editor, 'Mod-Shift-z');
    assert.equal(editor.state.doc.firstChild.textContent, 'va  lue');
    setCode(editor, 'one\ntwo\nthree', 1, 4);
    key(editor, 'Tab');
    assert.equal(editor.state.doc.firstChild.textContent, '  one\ntwo\nthree');
    key(editor, 'Shift-Tab');
    assert.equal(editor.state.doc.firstChild.textContent, 'one\ntwo\nthree');
    setCode(editor, '\nvalue');
    key(editor, 'Tab');
    assert.equal(editor.state.doc.firstChild.textContent, '  \nvalue');
    key(editor, 'Shift-Tab');
    assert.equal(editor.state.doc.firstChild.textContent, '\nvalue');
    setCode(editor, 'if (ok) {', 9);
    key(editor, 'Enter');
    assert.equal(editor.state.doc.firstChild.textContent, 'if (ok) {\n  ');
    editor.commands.setContent('<p>Plain note</p>');
    editor.commands.setTextSelection(1);
    key(editor, 'Tab');
    assert.equal(editor.state.doc.firstChild.textContent, '\tPlain note');
    key(editor, 'Shift-Tab');
    assert.equal(editor.state.doc.firstChild.textContent, 'Plain note');
    editor.commands.setContent('<p><strong>alpha</strong></p><p>beta</p>');
    editor.commands.setTextSelection({ from: 2, to: 10 });
    key(editor, 'Tab');
    assert.equal(editor.state.doc.firstChild.textContent, '\talpha');
    assert.equal(editor.state.doc.child(1).textContent, '\tbeta');
    key(editor, 'Shift-Tab');
    assert.equal(editor.getHTML(), '<p><strong>alpha</strong></p><p>beta</p>');
    editor.commands.setContent('<table><tbody><tr><td><p>one</p></td><td><p>two</p></td></tr></tbody></table>');
    editor.commands.setTextSelection(4);
    key(editor, 'Tab');
    assert.equal(editor.state.selection.$from.parent.textContent, 'two');
    key(editor, 'Shift-Tab');
    assert.equal(editor.state.selection.$from.parent.textContent, 'one');
    editor.commands.setContent('<p>Plain note</p>');
    editor.setEditable(false);
    key(editor, 'Tab');
    assert.equal(editor.state.doc.firstChild.textContent, 'Plain note');
  } finally { editor.destroy(); }
});

test('language selection updates highlighting and survives Markdown and HTML round trips', async () => {
  const editor = new Editor({ extensions: extensions(), content: '```js\nconst answer = "hello";\n```', contentType: 'markdown' });
  try {
    await act(async () => root.render(React.createElement(EditorContent, { editor })));
    assert.ok(document.querySelector('.hljs-keyword'));
    assert.equal(document.querySelector('.code-block pre').textContent, 'const answer = "hello";');
    await act(async () => document.querySelector('[role="combobox"]').click());
    await act(async () => [...document.querySelectorAll('[role="option"]')].find(option => option.textContent === 'Python').click());
    assert.equal(editor.state.doc.firstChild.attrs.language, 'python');
    assert.match(editor.getMarkdown(), /^```python/);
    const html = editor.getHTML();
    assert.match(html, /language-python/);
    assert.doesNotMatch(html, /combobox|Programming language/);
    await act(async () => editor.commands.setContent(html));
    assert.equal(editor.state.doc.firstChild.attrs.language, 'python');
    for (const language of ['unknown', 'constructor', '__proto__']) {
      await act(async () => editor.commands.setContent('```' + language + '\n<script>alert(1)</script>\n```', { contentType: 'markdown' }));
      assert.equal(document.querySelector('.code-block pre').textContent, '<script>alert(1)</script>');
      assert.equal(document.querySelector('script'), null);
    }
  } finally { await act(async () => root.render(null)); editor.destroy(); }
});

test('chat drafts keep Enter inside code and sent blocks render literal syntax with a language picker', async () => {
  let sent = 0;
  let markdown = '';
  const mentions = [];
  const ref = React.createRef();
  await act(async () => root.render(React.createElement(api.EmojiComposerInput, {
    ref, value: '```javascript\nconst value = "😀 @Fixture";\n```', pack: 'twemoji',
    onChange: value => { markdown = value; }, onSend: () => { sent++; },
    onMentionQueryChange: query => mentions.push(query),
  })));
  await act(async () => ref.current.focus());
  const composer = document.querySelector('.chat-composer-editor');
  assert.ok(composer.querySelector('.hljs-keyword'));
  assert.equal(composer.querySelector('.chat-editor-emoji'), null);
  await act(async () => ref.current.replaceRange({ from: 1, to: 1 }, '@decorator '));
  assert.ok(mentions.every(query => query === null), 'code never opens mention completion');
  await act(async () => composer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  assert.equal(sent, 0);
  assert.ok(markdown.includes('const value'));
  await act(async () => composer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })));
  assert.equal(sent, 1);
  await act(async () => root.render(React.createElement(api.ChatMessageContent, { text: markdown, pack: 'twemoji' })));
  assert.ok(document.querySelector('pre .hljs-keyword'));
  assert.match(document.querySelector('pre').textContent, /😀 @Fixture/);
  assert.equal(document.querySelector('.chat-msg-mention'), null);
  assert.ok(document.querySelector('[role="combobox"]'));
});
