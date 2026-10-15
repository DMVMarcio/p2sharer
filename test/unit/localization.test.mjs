import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { APP_LANGUAGES, detectLanguage, normalizeLanguage, readLanguage } from '../../src/i18n/language.ts';

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

test('primary locale detection supports every catalog, Chinese scripts and English fallback', () => {
  for (const language of ['pt-BR', 'pt-PT', 'PT_br', 'pt']) assert.equal(normalizeLanguage(language), 'pt-BR');
  for (const language of ['en-US', 'en-GB', 'EN', 'en_AU']) assert.equal(normalizeLanguage(language), 'en');
  for (const [input, expected] of Object.entries({ 'es-MX': 'es', 'fr-CA': 'fr', 'de-DE': 'de', 'it-IT': 'it', 'zh-CN': 'zh-CN', 'zh-SG': 'zh-CN', 'zh-TW': 'zh-TW', 'zh-HK': 'zh-TW', 'zh-MO': 'zh-TW', 'zh-Hans-TW': 'zh-CN', 'zh_Hant_CN': 'zh-TW', zh: 'zh-CN', 'ja-JP': 'ja', 'ko-KR': 'ko', 'hi-IN': 'hi', 'fi-FI': 'fi', 'ru-RU': 'ru' })) assert.equal(normalizeLanguage(input), expected, input);
  assert.equal(normalizeLanguage('nl-NL'), null);
  assert.equal(normalizeLanguage(null), null);
  assert.equal(detectLanguage(['nl-NL', 'pt-BR']), 'en');
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
  assert.equal(api.t('browser.activity.close-tab', { title: 'Página de exemplo' }), 'fechou a aba “Página de exemplo”');
  const badge = document.querySelector('[role="status"]');
  assert.equal(badge.getAttribute('aria-label'), '1 mensagem não lida');
  assert.equal(api.formatFileSize(1536), '1,5 KB');
  await act(async () => api.setLanguage('en'));
  assert.match(document.body.textContent, /Sala started Notepad/);
  assert.equal(api.t('browser.activity.close-tab', { title: 'Página de exemplo' }), 'closed the tab “Página de exemplo”');
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

test('extension import failures distinguish file count from package size in both languages', () => {
  const previous = api.getLanguage();
  try {
    api.setLanguage('pt-BR');
    assert.equal(api.localizeError(new Error('Extension contains too many files')), 'A extensão contém arquivos demais.');
    assert.equal(api.localizeError(new Error('Extension package exceeds size limit')), 'A extensão excede o limite de tamanho.');
    assert.equal(api.localizeError(new Error('Extension folder nesting exceeds limit')), 'A extensão contém pastas aninhadas demais.');
    assert.equal(api.localizeError(new Error('Too many installed extensions')), 'O limite de extensões instaladas foi atingido.');
    api.setLanguage('en');
    assert.equal(api.localizeError(new Error('Extension contains too many files')), 'Extension contains too many files');
  } finally { api.setLanguage(previous); }
});

test('virtual interface failures preserve the Windows error code in both languages', () => {
  const previous = api.getLanguage();
  const error = new Error('Virtual adapter initialization: Virtual network interface configuration failed (Windows code 87)');
  try {
    api.setLanguage('pt-BR');
    assert.equal(api.localizeError(error), 'O Windows recusou a configuração do adaptador virtual (código 87).');
    api.setLanguage('en');
    assert.equal(api.localizeError(error), error.message);
  } finally { api.setLanguage(previous); }
});

test('all catalogs cover every literal translation key and preserve interpolation variables', () => {
  const en = JSON.parse(readFileSync('src/i18n/locales/en.json', 'utf8'));
  for (const language of APP_LANGUAGES) {
    const catalog = JSON.parse(readFileSync(`src/i18n/locales/${language}.json`, 'utf8'));
    assert.deepEqual(Object.keys(en).sort(), Object.keys(catalog).sort(), language);
    for (const key of Object.keys(en)) {
      assert.ok(catalog[key].trim(), `${language}: ${key}`);
      assert.deepEqual(en[key].match(/\{\{[^}]+\}\}/g)?.sort(), catalog[key].match(/\{\{[^}]+\}\}/g)?.sort(), `${language}: ${key}`);
      if (/^(?:wss?|https?|stun|turn):/.test(en[key])) {
        assert.equal(catalog[key], en[key], `${language}: protocol example ${key}`);
      }
    }
    for (const category of new Intl.PluralRules(language).resolvedOptions().pluralCategories) {
      for (const base of ['tunnels.previewActive', 'tunnels.dropped', 'tunnels.connections', 'chat.unread', 'audio.detectedApps']) {
        assert.ok(catalog[`${base}_${category}`], `${language}: ${base}_${category}`);
      }
    }
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

test('every offline emoji has an accessible name in every supported language', () => {
  const catalog = JSON.parse(readFileSync('src/core/emoji_catalog.json', 'utf8'));
  const en = JSON.parse(readFileSync('src/i18n/locales/emoji-en.json', 'utf8'));
  const pt = JSON.parse(readFileSync('src/i18n/locales/emoji-pt-BR.json', 'utf8'));
  for (const language of APP_LANGUAGES) {
    const labels = JSON.parse(readFileSync(`src/i18n/locales/emoji-${language}.json`, 'utf8'));
    assert.deepEqual(Object.keys(en).sort(), Object.keys(labels).sort(), language);
    for (const entry of catalog) assert.ok(labels[`emoji.${entry.emoji}`]?.trim(), `${language}: ${entry.name}`);
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

test('all languages persist, synchronize detached windows and render localized app and emoji copy', async () => {
  const previous = api.getLanguage();
  const english = JSON.parse(readFileSync('src/i18n/locales/en.json', 'utf8'));
  try {
    for (const language of APP_LANGUAGES) {
      await act(async () => api.setLanguage(language));
      assert.equal(readLanguage(), language);
      assert.equal(api.getLanguage(), language);
      assert.equal(document.documentElement.lang, language);
      const catalog = JSON.parse(readFileSync(`src/i18n/locales/${language}.json`, 'utf8'));
      assert.equal(api.t('language.label'), catalog['language.label']);
      if (language !== 'en') assert.notEqual(api.t('error.unknown'), english['error.unknown']);
      for (const count of [0, 1, 2, 5, 21, 22, 101, 1.5, 1000000]) {
        const category = new Intl.PluralRules(language).select(count);
        assert.equal(api.t('chat.unread', { count }), catalog[`chat.unread_${category}`].replace('{{count}}', String(count)));
      }
      assert.equal(api.localizeText(catalog['roomExit.title']), catalog['roomExit.title']);
      localStorage.setItem('p2sharer_language', language);
      await act(async () => { window.dispatchEvent(new window.StorageEvent('storage', { key: 'p2sharer_language' })); });
      assert.equal(api.getLanguage(), language);
      const emojis = JSON.parse(readFileSync(`src/i18n/locales/emoji-${language}.json`, 'utf8'));
      assert.equal(api.t('emoji.😀'), emojis['emoji.😀']);
    }
    await act(async () => api.setLanguage('en'));
    const russian = JSON.parse(readFileSync('src/i18n/locales/ru.json', 'utf8'));
    assert.equal(api.localizeText(russian['roomExit.title']), english['roomExit.title']);
  } finally { await act(async () => api.setLanguage(previous)); }
});
