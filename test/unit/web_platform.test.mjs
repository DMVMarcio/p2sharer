import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import 'fake-indexeddb/auto';

const bundle = await build({ stdin: { contents: `
  export { invokeBrowser } from './src/platform/web_commands.ts';
  export { browserRecord } from './src/platform/web_storage.ts';
  export { registerBrowserFile } from './src/platform/web_files.ts';
`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'web-platform-translator', setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)i18n(?:\/index\.ts)?$/ }, () => ({ path: 'i18n', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const t = key => key;' }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=web-platform-test.js').toString('base64')}`);

test('browser documents persist, isolate libraries and reject stale writes atomically', async () => {
  const invoke = api.invokeBrowser;
  const id = crypto.randomUUID();
  const note = await invoke('save_library_note', { id, name: 'Fixture', content: 'First', expectedUpdatedAt: null });
  assert.equal((await invoke('read_saved_note', { id })).content, 'First');
  assert.equal((await invoke('list_saved_notes', { library: 'whiteboard' })).notes.length, 0);
  await assert.rejects(invoke('save_library_note', { id, name: 'Fixture', content: 'Stale', expectedUpdatedAt: null }), /Document changed/);
  const renamed = await invoke('rename_library_note', { id, name: 'Renamed', expectedUpdatedAt: note.updatedAt });
  assert.equal(renamed.content, 'First'); assert.ok(renamed.updatedAt > note.updatedAt);
  await invoke('delete_library_note', { id, expectedUpdatedAt: renamed.updatedAt });
  await assert.rejects(invoke('read_saved_note', { id }), /unavailable/);
  await api.browserRecord('atomic', () => ({ value: 0 }));
  await Promise.all(Array.from({ length: 10 }, () => api.browserRecord('atomic', item => ({ value: item.value + 1 }))));
  assert.equal((await api.browserRecord('atomic')).value, 10);
  await assert.rejects(invoke('start_lan_signaling'), /web.desktopOnly/);
});

test('browser files use signed chunk offsets and verify full hashes before exporting', async context => {
  const invoke = api.invokeBrowser;
  const source = await api.registerBrowserFile(new Blob(['hello world']), 'fixture.txt');
  assert.equal((await invoke('inspect_chat_file', { id: source.id })).hash, source.hash);
  const part = await invoke('read_chat_file_bytes', { id: source.id, offset: 6, length: 5 });
  assert.equal(new TextDecoder().decode(part), 'world');
  const id = crypto.randomUUID();
  await invoke('choose_chat_download', { id, name: 'fixture.txt', size: 11, hash: '0'.repeat(64) });
  const write = (offset, text) => invoke('write_chat_download_bytes', new TextEncoder().encode(text),
    { headers: { 'x-chat-download-id': id, 'x-chat-offset': String(offset) } });
  assert.equal(await write(0, 'hello '), 6);
  await assert.rejects(write(0, 'hello '), /offset/);
  assert.equal(await write(6, 'world'), 11);
  await assert.rejects(invoke('finish_chat_download', { id }), /hash mismatch/);
  await assert.rejects(invoke('finish_chat_download', { id }), /Incomplete/);
  const previousDocument = globalThis.document;
  const exports = [];
  globalThis.document = { createElement: () => {
    const link = { click: () => exports.push(link.download) }; return link;
  } };
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await invoke('choose_chat_download', { id, name: 'fixture.txt', size: 11, hash: source.hash });
    assert.equal(await write(0, 'hello world'), 11);
    assert.equal(await invoke('finish_chat_download', { id }), 'fixture.txt');
    assert.deepEqual(exports, ['fixture.txt']);
    context.mock.timers.tick(60_000);
  } finally { globalThis.document = previousDocument; context.mock.timers.reset(); }
  await assert.rejects(invoke('choose_chat_download', { id, size: 257 * 1024 * 1024 }), /web.fileLimit/);
  await invoke('discard_chat_file', { id: source.id });
  await assert.rejects(invoke('read_chat_file_bytes', { id: source.id, offset: 0, length: 1 }), /Invalid read/);
});

test('browser profile validation preserves native geometry and verifies content before decoding', async () => {
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
  const previousDecoder = globalThis.createImageBitmap;
  const previousReader = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsDataURL(blob) { void blob.arrayBuffer().then(buffer => { this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`; this.onloadend(); }); }
  };
  let decodes = 0;
  globalThis.createImageBitmap = async () => { decodes++; return { close() {} }; };
  try {
    await api.invokeBrowser('validate_profile_image_bytes', bytes, { headers: { 'x-profile-hash': hash, 'x-profile-banner': 'false' } });
    assert.equal(decodes, 1);
    await assert.rejects(api.invokeBrowser('validate_profile_image_bytes', bytes, { headers: { 'x-profile-hash': '0'.repeat(64) } }), /Invalid image/);
    await assert.rejects(api.invokeBrowser('validate_profile_image_bytes', bytes, { headers: { 'x-profile-hash': hash, 'x-profile-banner': 'true' } }), /Invalid image/);
    assert.equal(decodes, 1, 'untrusted bytes never reach the image decoder before geometry and hash checks');
  } finally { globalThis.createImageBitmap = previousDecoder; globalThis.FileReader = previousReader; }
});
