import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { detectLanguage, normalizeLanguage, readLanguage } from '../../src/i18n/language.ts';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'DOMParser', 'MutationObserver', 'localStorage']) globalThis[key] = dom.window[key];
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let localeReads = 0;
globalThis.readSystemLocaleFixture = () => { localeReads++; return 'pt-BR'; };
const bundle = await build({ stdin: { contents: `
  export * from './src/i18n/index.ts';
  export { SystemNoticeText } from './src/components/room/SystemNoticeText.tsx';
  export { UnreadChatBadge } from './src/components/room/UnreadChatBadge.tsx';
  export { EmojiComposerInput } from './src/components/common/EmojiComposerInput.tsx';
  export { formatFileSize } from './src/core/file_size.ts';
  export { getRoomApp } from './src/apps/registry.ts';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
  plugins: [{ name: 'localization-native-fixture', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'core', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
      `export const isTauri = () => true; export const invoke = async command => {
        if (command !== 'get_system_locale') throw new Error('Unexpected command');
        return globalThis.readSystemLocaleFixture(); };` }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
  } }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=localization-test-bundle.js').toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
after(async () => { await act(async () => root.unmount()); dom.window.close(); delete globalThis.readSystemLocaleFixture; });

test('primary locale detection accepts English and Portuguese variants with English fallback', () => {
  for (const language of ['pt-BR', 'pt-PT', 'PT_br', 'pt']) assert.equal(normalizeLanguage(language), 'pt-BR');
  for (const language of ['en-US', 'en-GB', 'EN', 'en_AU']) assert.equal(normalizeLanguage(language), 'en');
  assert.equal(normalizeLanguage('fr-FR'), null);
  assert.equal(normalizeLanguage(null), null);
  assert.equal(detectLanguage(['fr-FR', 'pt-BR']), 'en');
  assert.equal(detectLanguage([]), 'en');
  localStorage.setItem('p2sharer_language', 'de-DE');
  assert.equal(readLanguage(), null);
  localStorage.removeItem('p2sharer_language');
});

test('first launch reads Windows once, saves the language and synchronizes detached windows', async () => {
  await Promise.all([api.initializeLanguage(), api.initializeLanguage()]);
  assert.equal(localeReads, 1);
  assert.equal(api.getLanguage(), 'pt-BR');
  assert.equal(localStorage.getItem('p2sharer_language'), 'pt-BR');
  api.setLanguage('en');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(readLanguage(), 'en');
  await api.initializeLanguage();
  assert.equal(api.getLanguage(), 'en');
  assert.equal(localeReads, 1);
  localStorage.setItem('p2sharer_language', 'pt-BR');
  window.dispatchEvent(new window.StorageEvent('storage', { key: 'p2sharer_language' }));
  assert.equal(api.getLanguage(), 'pt-BR');
  assert.equal(document.documentElement.lang, 'pt-BR');
});

test('a saved preference wins over a different system language on later launches', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    Object.defineProperty(globalThis, 'navigator', { value: { languages: ['pt-BR'] } });
    globalThis.localStorage = { getItem: () => 'en' };
    const api = await import('./src/i18n/index.ts');
    await api.initializeLanguage();
    if (api.getLanguage() !== 'en') process.exit(1);
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('mounted notices, unread plurals and number formats change without translating authored names', async () => {
  const message = { isSystem: true, systemType: 'app-start', systemActor: 'Sala', systemAppKind: 'notepad', text: 'Sala iniciou Bloco de notas' };
  await act(async () => root.render(React.createElement(React.Fragment, null,
    React.createElement(api.SystemNoticeText, { message }), React.createElement(api.UnreadChatBadge, { count: 1 }))));
  assert.match(document.body.textContent, /Sala iniciou Bloco de notas/);
  const badge = document.querySelector('[role="status"]');
  assert.equal(badge.getAttribute('aria-label'), '1 mensagem não lida');
  assert.equal(api.formatFileSize(1536), '1,5 KB');
  await act(async () => api.setLanguage('en'));
  assert.match(document.body.textContent, /Sala started Notepad/);
  assert.equal(document.querySelector('strong').textContent, 'Sala');
  assert.equal(document.querySelector('[role="status"]'), badge);
  assert.equal(badge.getAttribute('aria-label'), '1 unread message');
  assert.equal(api.formatFileSize(1536), '1.5 KB');
  assert.equal(message.text, 'Sala iniciou Bloco de notas');
  assert.equal(api.getRoomApp('notepad').protocolLabel, 'Bloco de notas');
  assert.equal(api.getRoomApp('notepad').label, 'Notepad');
  await act(async () => root.render(React.createElement(api.UnreadChatBadge, { count: 2 })));
  assert.equal(document.querySelector('[role="status"]').getAttribute('aria-label'), '2 unread messages');
  assert.equal(api.localizeText('Concluído'), 'Completed');
  assert.equal(api.localizeError(new Error('Note file is too large')), 'Note file is too large');
  assert.equal(api.localizeError(new Error('Unknown platform detail')), api.t('error.unknown'));
});

test('both catalogs cover every literal translation key and preserve interpolation variables', () => {
  const en = JSON.parse(readFileSync('src/i18n/locales/en.json', 'utf8'));
  const pt = JSON.parse(readFileSync('src/i18n/locales/pt-BR.json', 'utf8'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(pt).sort());
  for (const key of Object.keys(en)) {
    assert.ok(en[key].trim(), key); assert.ok(pt[key].trim(), key);
    assert.deepEqual(en[key].match(/\{\{[^}]+\}\}/g)?.sort(), pt[key].match(/\{\{[^}]+\}\}/g)?.sort(), key);
  }
  for (const file of readdirSync('src', { recursive: true }).filter(file => /\.tsx?$/.test(file))) {
    const source = ts.createSourceFile(file, readFileSync(`src/${file}`, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && ts.isStringLiteral(node.arguments[0])) {
        const key = node.arguments[0].text;
        assert.ok(en[key] || en[`${key}_one`] && en[`${key}_other`], `${file}: ${key}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});

test('every offline emoji has an accessible name in both languages', () => {
  const catalog = JSON.parse(readFileSync('src/core/emoji_catalog.json', 'utf8'));
  const en = JSON.parse(readFileSync('src/i18n/locales/emoji-en.json', 'utf8'));
  const pt = JSON.parse(readFileSync('src/i18n/locales/emoji-pt-BR.json', 'utf8'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(pt).sort());
  for (const entry of catalog) {
    assert.ok(en[`emoji.${entry.emoji}`]?.trim(), entry.name);
    assert.ok(pt[`emoji.${entry.emoji}`]?.trim(), entry.name);
  }
  assert.equal(en['emoji.😀'], 'grinning face');
  assert.equal(pt['emoji.😀'], 'rosto risonho');
});

test('an open chat composer updates its placeholder and keeps the draft and editor instance', async () => {
  const composer = React.createRef();
  function Harness() {
    const [value, setValue] = useState('');
    return React.createElement(api.EmojiComposerInput, { ref: composer, value, pack: 'native', onChange: setValue, onSend() {} });
  }
  await act(async () => { api.setLanguage('pt-BR'); root.render(React.createElement(Harness)); });
  const editor = document.querySelector('.chat-composer-editor');
  assert.equal(editor.querySelector('p').getAttribute('data-placeholder'), 'Digite uma mensagem...');
  await act(async () => api.setLanguage('en'));
  assert.equal(editor.querySelector('p').getAttribute('data-placeholder'), 'Type a message...');
  assert.equal(editor.getAttribute('aria-label'), 'Message');
  await act(async () => composer.current.insertEmoji('😀'));
  assert.equal(composer.current.getMarkdown(), '😀');
  await act(async () => api.setLanguage('pt-BR'));
  assert.equal(composer.current.getMarkdown(), '😀');
  assert.equal(document.querySelector('.chat-composer-editor'), editor);
  assert.equal(editor.getAttribute('aria-label'), 'Mensagem');
});
