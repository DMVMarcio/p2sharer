import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'DOMParser', 'MutationObserver', 'localStorage', 'Event', 'CustomEvent'])
  globalThis[key] = dom.window[key];
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
HTMLElement.prototype.scrollIntoView = () => {};
const fixture = globalThis.notepadFixture = { model: null, editor: null, notes: new Map(), calls: [], imported: null, subscriptions: new Set() };
fixture.invoke = async (command, args) => {
  fixture.calls.push({ command, args });
  if (command === 'list_saved_notes') return { directory: 'Notes', notes: [...fixture.notes.values()].map(note => ({ ...note, content: '' })) };
  if (command === 'read_saved_note') return { ...fixture.notes.get(args.id) };
  if (command === 'delete_library_note') {
    assert.equal(args.expectedUpdatedAt, fixture.notes.get(args.id).updatedAt);
    fixture.notes.delete(args.id); return;
  }
  if (command === 'rename_library_note') {
    const current = fixture.notes.get(args.id);
    assert.equal(args.expectedUpdatedAt, current.updatedAt);
    const note = { ...current, name: args.name, updatedAt: current.updatedAt + 1 };
    fixture.notes.set(note.id, note); return { ...note };
  }
  if (command === 'save_library_note') {
    const current = fixture.notes.get(args.id);
    assert.equal(args.expectedUpdatedAt, current?.updatedAt ?? null);
    const note = { id: args.id, name: args.name, content: args.content, updatedAt: (current?.updatedAt ?? 0) + 1 };
    fixture.notes.set(note.id, note); return { ...note };
  }
  if (command === 'open_note_file') return fixture.imported;
  if (command === 'save_note_file') return true;
  if (command === 'pick_whiteboard_image') return fixture.pickedImage ?? null;
  if (command === 'paste_whiteboard_image') return fixture.pastedImage;
  throw new Error(`Unexpected command: ${command}`);
};
const mocks = {
  core: 'export const isTauri = () => globalThis.notepadFixture.native ?? false; export const invoke = (...args) => globalThis.notepadFixture.invoke(...args);',
  event: `export const listen = async (_event, callback) => { const subscriptions = globalThis.notepadFixture.subscriptions; subscriptions.add(callback); return () => subscriptions.delete(callback); };`,
  webview: 'export const getCurrentWebview = () => ({ onDragDropEvent: async () => () => {} });',
  room_apps_service: 'export const roomAppsService = { getModel: () => globalThis.notepadFixture.model, getLocalActor: () => "fixture" };',
  useRoom: 'export const useRoom = () => ({ username: "Fixture" });',
  useToast: 'export const showToast = () => {};',
  useTextEditorContextMenu: 'export const useTextEditorContextMenu = () => {};',
  NotepadToolbar: `import React from 'react'; export const NotepadToolbar = ({ editor, onImage, fileActions }) => {
    globalThis.notepadFixture.editor = editor;
    return React.createElement('div', { 'data-toolbar': true },
      onImage ? React.createElement('button', { type: 'button', onClick: onImage }, 'Image') : null,
      fileActions,
    );
  };`,
};
const bundle = await build({ stdin: { contents: `export { NotepadApp } from './src/apps/NotepadApp.tsx';
  export { resizedNoteImageDimensions } from './src/apps/NotepadImageExtension.tsx';
  export { sha256Hex, decodeBase64 } from './src/apps/whiteboard_image.ts';
  export { useDocumentLibraryDeletion } from './src/apps/useDocumentLibraryDeletion.ts';
  export { NotepadModel } from './src/apps/models.ts'; export { setLanguage } from './src/i18n/index.ts';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic',
  plugins: [{ name: 'notepad-native-fixture', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({ path: 'event', namespace: 'fixture' }));
    builder.onResolve({ filter: /^(?:@tauri-apps\/api\/core|.*\/platform\/commands\.ts)$/ }, () => ({ path: 'core', namespace: 'fixture' }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/webview$/ }, () => ({ path: 'webview', namespace: 'fixture' }));
    builder.onResolve({ filter: /\/(room_apps_service|useRoom|useToast|useTextEditorContextMenu|NotepadToolbar)$/ }, args => ({
      path: args.path.split('/').at(-1), namespace: 'fixture',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path] }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
  } }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=notepad-files-test-bundle.js').toString('base64')}`);
api.setLanguage('en');
fixture.model = new api.NotepadModel({ localActor: 'fixture', emit() {}, changed() {} });
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
const instanceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
const button = (label, scope = document) => [...scope.querySelectorAll('button')].find(button => button.textContent === label);
const click = async (label, scope = document) => {
  const target = button(label, scope); assert.ok(target, `Missing button: ${label}`);
  await act(async () => target.click()); await settle();
};
const toolbar = () => document.querySelector('[data-toolbar]');
after(async () => {
  await act(async () => root.unmount()); fixture.model.destroy(); dom.window.close(); delete globalThis.notepadFixture;
});

test('notes save to the library, reopen with identity, and update the same file through Ctrl+S', async () => {
  await act(async () => root.render(React.createElement(api.NotepadApp, { instanceId })));
  await settle();
  await act(async () => fixture.editor.commands.setContent('<h1>Title</h1><p>First note</p>'));
  await click('Save', toolbar());
  assert.match(document.querySelector('[role="dialog"]').textContent, /copy on this computer/);
  await click('Save', document.querySelector('[role="dialog"]'));
  assert.equal(fixture.notes.size, 1);
  assert.equal(fixture.model.noteIdentity.id, instanceId);
  assert.match(document.querySelector('[role="status"]').textContent, /Saved on this computer/);
  await act(async () => fixture.editor.commands.setContent('<p>Updated</p>'));
  await act(async () => document.querySelector('.room-app-notepad-editor').dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 's', ctrlKey: true, bubbles: true, cancelable: true,
  })));
  assert.equal(fixture.notes.size, 1);
  assert.equal(fixture.notes.get(instanceId).content, '<p>Updated</p>');
  await click('New File', toolbar());
  await click('Replace content', document.querySelector('[role="dialog"]'));
  assert.equal(fixture.editor.isEmpty, true);
  assert.notEqual(fixture.model.noteIdentity.id, instanceId);
  await click('Open', toolbar());
  await click('Open', document.querySelector('[role="dialog"]'));
  assert.equal(fixture.editor.getHTML(), '<p>Updated</p>');
  assert.equal(fixture.model.noteIdentity.id, instanceId);
});

test('exports leave the saved binding intact and TXT imports preserve literal markup', async () => {
  await act(async () => fixture.editor.commands.setContent('<h1>Heading</h1><p>Text</p>'));
  await click('Export', toolbar());
  await click('Export', document.querySelector('[role="dialog"]'));
  const exported = fixture.calls.findLast(call => call.command === 'save_note_file');
  assert.equal(exported.args.format, 'md');
  assert.match(exported.args.content, /^# Heading/);
  assert.equal(fixture.model.noteIdentity.id, instanceId);
  assert.equal(fixture.notes.get(instanceId).content, '<p>Updated</p>');
  for (const [format, keys, expected] of [
    ['txt', ['Home', 'ArrowDown', 'Enter'], 'Heading\nText'],
    ['html', ['End', 'Enter'], '<h1>Heading</h1><p>Text</p>'],
  ]) {
    await click('Export', toolbar());
    const select = document.querySelector('[role="combobox"]');
    for (const key of keys) await act(async () => select.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true })));
    await click('Export', document.querySelector('[role="dialog"]'));
    const result = fixture.calls.findLast(call => call.command === 'save_note_file');
    assert.equal(result.args.format, format);
    assert.equal(result.args.content, expected);
    assert.equal(fixture.model.noteIdentity.id, instanceId);
  }
  fixture.imported = ['**literal**\n<text>', 'txt'];
  await click('Open', toolbar());
  await click('Import file', document.querySelector('[role="dialog"]'));
  assert.match(document.querySelector('[role="dialog"]').textContent, /everyone editing/);
  await click('Cancel', document.querySelector('[role="dialog"]'));
  assert.equal(fixture.editor.getHTML(), '<h1>Heading</h1><p>Text</p>');
  await click('Open', toolbar());
  await click('Import file', document.querySelector('[role="dialog"]'));
  await click('Replace content', document.querySelector('[role="dialog"]'));
  assert.equal(fixture.editor.getHTML(), '<p>**literal**</p><p>&lt;text&gt;</p>');
  assert.notEqual(fixture.model.noteIdentity.id, instanceId);
});

test('another participant can explicitly save a linked local copy and later saves keep its identity', async () => {
  const sharedId = '11111111-2222-3333-4444-555555555555';
  await act(async () => {
    fixture.model.setNoteIdentity(sharedId, 'Participant note');
    fixture.editor.commands.setContent('<p>Shared content</p>');
  });
  await click('Save', toolbar());
  assert.equal(document.querySelector('[role="dialog"] input').value, 'Participant note');
  await click('Save', document.querySelector('[role="dialog"]'));
  await act(async () => fixture.editor.commands.setContent('<p>Shared update</p>'));
  await click('Save', toolbar());
  assert.equal(fixture.notes.get(sharedId).content, '<p>Shared update</p>');
  assert.equal(fixture.notes.size, 2);
});

test('a peer opening another note during the name dialog cannot redirect the pending save', async () => {
  await act(async () => {
    fixture.model.setNoteIdentity('22222222-3333-4444-5555-666666666666', 'Original');
    fixture.editor.commands.setContent('<p>Original</p>');
  });
  await click('Save', toolbar());
  await act(async () => {
    fixture.model.setNoteIdentity('33333333-4444-5555-6666-777777777777', 'Another note');
    fixture.editor.commands.setContent('<p>Opened by a peer</p>');
  });
  await click('Save', document.querySelector('[role="dialog"]'));
  assert.match(document.querySelector('[role="alert"]').textContent, /open note changed/);
  assert.equal(fixture.notes.size, 2);
  await click('Cancel', document.querySelector('[role="dialog"]'));
});


test('renaming the open note preserves unsaved content and advances its local revision', async () => {
  const note = fixture.notes.get(instanceId);
  await act(async () => { fixture.model.setNoteIdentity(note.id, note.name); fixture.editor.commands.setContent('<p>Unsaved changes</p>'); });
  await click('Open', toolbar());
  const row = [...document.querySelectorAll('.notepad-files-row')].find(row => row.textContent.includes(note.name));
  await act(async () => row.querySelector('[aria-label="Rename"]').click()); await settle();
  const child = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  const input = child.querySelector('input');
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Renamed note'); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await click('Rename', child);
  assert.equal(fixture.model.noteIdentity.name, 'Renamed note');
  assert.equal(fixture.editor.getHTML(), '<p>Unsaved changes</p>');
  assert.notEqual(fixture.notes.get(instanceId).content, '<p>Unsaved changes</p>');
  await click('Cancel', document.querySelector('[role="dialog"]'));
  await click('Save', toolbar());
  assert.equal(fixture.notes.get(instanceId).content, '<p>Unsaved changes</p>');
});

test('saving by an existing name requires separate overwrite consent and adopts the saved identity', async () => {
  const old = fixture.notes.get(instanceId);
  await act(async () => { fixture.model.setNoteIdentity('99999999-aaaa-bbbb-cccc-dddddddddddd', old.name); fixture.editor.commands.setContent('<p>Replacement</p>'); });
  await click('Save', toolbar());
  await click('Save', document.querySelector('[role="dialog"]'));
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 2);
  assert.notEqual(fixture.notes.get(instanceId).content, '<p>Replacement</p>');
  await click('Choose another name', [...document.querySelectorAll('[role="dialog"]')].at(-1));
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
  await click('Save', document.querySelector('[role="dialog"]'));
  await click('Overwrite', [...document.querySelectorAll('[role="dialog"]')].at(-1));
  await settle();
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(fixture.notes.get(instanceId).content, '<p>Replacement</p>');
  assert.equal(fixture.model.noteIdentity.id, instanceId);
});


test('deleting a saved open note requires consent, retains the draft, and asks for a name on the next save', async () => {
  const note = fixture.notes.get(instanceId);
  await act(async () => fixture.editor.commands.setContent('<p>Keep this unsaved content</p>'));
  await click('Open', toolbar());
  const row = () => [...document.querySelectorAll('.notepad-files-row')].find(row => row.textContent.includes(note.name));
  await act(async () => row().querySelector('[aria-label="Delete"]').click()); await settle();
  await click('Cancel', [...document.querySelectorAll('[role="dialog"]')].at(-1));
  assert.ok(fixture.notes.has(instanceId));
  await act(async () => row().querySelector('[aria-label="Delete"]').click()); await settle();
  await click('Delete', [...document.querySelectorAll('[role="dialog"]')].at(-1));
  assert.equal(fixture.notes.has(instanceId), false);
  assert.equal(fixture.editor.getHTML(), '<p>Keep this unsaved content</p>');
  assert.equal(fixture.model.noteIdentity.id, instanceId);
  assert.ok(!row());
  await click('Cancel', document.querySelector('[role="dialog"]'));
  await click('Save', toolbar());
  assert.equal(document.querySelector('[role="dialog"] input').value, note.name);
  assert.equal(fixture.notes.has(instanceId), false);
  await click('Save', document.querySelector('[role="dialog"]'));
  assert.equal(fixture.notes.get(instanceId).content, '<p>Keep this unsaved content</p>');
});


test('device-local deletion events filter the document library, update callbacks, and release subscriptions', async () => {
  fixture.native = true;
  const host = document.createElement('div'); document.body.append(host);
  const subscriptionRoot = createRoot(host), received = [];
  function Subscriber({ label }) { api.useDocumentLibraryDeletion('notes', id => received.push([label, id])); return null; }
  try {
    await act(async () => subscriptionRoot.render(React.createElement(Subscriber, { label: 'first' })));
    assert.equal(fixture.subscriptions.size, 1);
    const notify = library => fixture.subscriptions.forEach(callback => callback({ payload: { library, id: instanceId } }));
    notify('whiteboard'); assert.deepEqual(received, []);
    notify('notes'); assert.deepEqual(received, [['first', instanceId]]);
    await act(async () => subscriptionRoot.render(React.createElement(Subscriber, { label: 'latest' })));
    notify('notes'); assert.deepEqual(received.at(-1), ['latest', instanceId]);
  } finally { await act(async () => subscriptionRoot.unmount()); host.remove(); fixture.native = false; }
  assert.equal(fixture.subscriptions.size, 0);
});

test('notepad inserts sanitized images by file, link, paste, and drag-and-drop, resizes with Shift aspect lock, and syncs chunks over P2P', async () => {
  const samplePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4z8DAwMAAAggB/1p6pJcAAAAASUVORK5CYII=';
  const sampleBytes = api.decodeBase64(samplePngBase64);
  const sampleHash = await api.sha256Hex(sampleBytes);
  const sampleRecord = { hash: sampleHash, data: samplePngBase64, width: 120, height: 80 };

  await act(async () => fixture.editor.commands.clearContent());

  // 1. Insert by file picker
  fixture.pickedImage = sampleRecord;
  await click('Image', toolbar());
  await click('Choose file');
  assert.equal(fixture.calls.at(-1).command, 'pick_whiteboard_image');
  assert.match(fixture.editor.getHTML(), new RegExp(`data-image-hash="${sampleHash}"`));

  // 2. Insert by URL link
  await act(async () => fixture.editor.commands.clearContent());
  fixture.pastedImage = sampleRecord;
  await click('Image', toolbar());
  const urlInput = document.querySelector('input[aria-label="Image URL"]');
  assert.ok(urlInput);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(urlInput, 'https://example.com/photo.png');
    urlInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await click('Apply');
  assert.equal(fixture.calls.at(-1).command, 'paste_whiteboard_image');
  assert.equal(fixture.calls.at(-1).args.url, 'https://example.com/photo.png');
  assert.match(fixture.editor.getHTML(), new RegExp(`data-image-hash="${sampleHash}"`));

  // 3. Insert by Ctrl+V paste and 4. Drag and drop
  globalThis.FileReader = window.FileReader;
  try {
    await act(async () => fixture.editor.commands.clearContent());
    const rootEl = document.querySelector('.room-app-notepad');
    const fakeFile = new window.Blob([sampleBytes], { type: 'image/png' });
    const pasteEvent = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { items: [{ type: 'image/png', getAsFile: () => fakeFile }], files: [fakeFile], getData: () => '' },
    });
    await act(async () => { rootEl.dispatchEvent(pasteEvent); });
    await settle();
    assert.match(fixture.editor.getHTML(), new RegExp(`data-image-hash="${sampleHash}"`));

    await act(async () => fixture.editor.commands.clearContent());
    const dropEvent = new window.MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: { files: [fakeFile], items: [{ type: 'image/png' }], types: ['Files'] },
    });
    await act(async () => { rootEl.dispatchEvent(dropEvent); });
    await settle();
    assert.match(fixture.editor.getHTML(), new RegExp(`data-image-hash="${sampleHash}"`));
  } finally {
    delete globalThis.FileReader;
  }

  // 5. Resize dimensions (free stretch vs Shift aspect-ratio lock)
  assert.deepEqual(api.resizedNoteImageDimensions(120, 80, 'se', 60, 10, false), { width: 180, height: 90 });
  assert.deepEqual(api.resizedNoteImageDimensions(120, 80, 'se', 60, 10, true), { width: 180, height: 120 });

  // 6. P2P chunked transfer between two NotepadModel peers
  const peerEvents = [];
  const hostEvents = [];
  const hostModel = new api.NotepadModel({
    localActor: 'host',
    emit: payload => hostEvents.push(payload),
    send: async (payload) => { peerEvents.push(payload); },
    changed() {},
  });
  const peerModel = new api.NotepadModel({
    localActor: 'peer',
    emit: payload => peerEvents.push(payload),
    send: async (payload) => { hostEvents.push(payload); },
    changed() {},
  });
  try {
    hostModel.setParticipants(['host', 'peer']);
    peerModel.setParticipants(['host', 'peer']);
    hostModel.registerImage(sampleRecord);
    hostModel.apply(fixture.model.snapshot(), 'fixture', true);
    peerModel.apply(hostModel.snapshot(), 'host', false);
    const req = hostEvents.find(e => e.imageRequest);
    assert.ok(req, 'Peer should request missing image hash from host');
    hostModel.apply(req, 'peer', false);
    await settle();
    const chunks = peerEvents.filter(e => e.imageChunk);
    assert.ok(chunks.length > 0, 'Host should send image chunks to peer');
    for (const chunk of chunks) peerModel.apply(chunk, 'host', false);
    await settle();
    assert.equal(peerModel.imageUrl(sampleHash), `data:image/png;base64,${samplePngBase64}`);
  } finally {
    hostModel.destroy();
    peerModel.destroy();
  }
});

test('code languages and keyboard edits persist in the collaborative note snapshot', async () => {
  await act(async () => fixture.editor.commands.setContent('```python\nprint("hello")\n```', { contentType: 'markdown' }));
  await act(async () => fixture.editor.commands.setTextSelection(1));
  await act(async () => document.querySelector('.room-app-notepad-editor').dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Tab', bubbles: true, cancelable: true,
  })));
  assert.match(fixture.editor.getMarkdown(), /```python\n  print/);
  assert.ok(document.querySelector('.room-app-notepad-editor .hljs-built_in'));
  const remote = new api.NotepadModel({ localActor: 'peer', emit() {}, changed() {} });
  try {
    remote.apply(fixture.model.snapshot(), 'fixture', true);
    const code = remote.richContent.toArray().find(node => node.nodeName === 'codeBlock');
    assert.ok(code);
    assert.equal(code.getAttribute('language'), 'python');
    assert.match(code.toString(), /  print/);
  } finally { remote.destroy(); }
});
