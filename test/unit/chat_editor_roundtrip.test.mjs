import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const browser = new JSDOM('<!doctype html><html><body></body></html>');
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'DOMParser', 'MutationObserver']) {
  globalThis[key] = browser.window[key];
}
Object.defineProperty(globalThis, 'navigator', { value: browser.window.navigator, configurable: true });

const { Editor } = await import('@tiptap/core');
const { default: StarterKit } = await import('@tiptap/starter-kit');
const { Markdown } = await import('@tiptap/markdown');

test('rich chat content keeps formatting through Markdown serialization', () => {
  const editor = new Editor({
    extensions: [StarterKit, Markdown],
    content: 'Oi **amigo** e [site](https://example.com)',
    contentType: 'markdown',
  });
  try {
    assert.match(editor.getHTML(), /<strong>amigo<\/strong>/);
    assert.match(editor.getHTML(), /<a[^>]+href="https:\/\/example.com"/);
    assert.match(editor.getMarkdown(), /\*\*amigo\*\*/);
    assert.match(editor.getMarkdown(), /\[site\]\(https:\/\/example.com\)/);

    editor.commands.setContent('```js\nconst x = 1\n```', { contentType: 'markdown' });
    assert.match(editor.getHTML(), /<pre>/);
    assert.match(editor.getMarkdown(), /```js/);

    editor.commands.setContent('abc 😀', { contentType: 'markdown' });
    editor.commands.setTextSelection({ from: 1, to: 4 });
    editor.commands.toggleBold();
    assert.match(editor.getHTML(), /<strong>abc<\/strong>/);
    assert.match(editor.getMarkdown(), /\*\*abc\*\* 😀/);
  } finally {
    editor.destroy();
  }
});
