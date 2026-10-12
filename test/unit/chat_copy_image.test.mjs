import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'FileReader', 'Blob', 'Response', 'localStorage']) {
  globalThis[key] = dom.window[key];
}

const bundle = await build({
  stdin: {
    contents: `
      export { getChatMessageActions } from './src/components/room/chat_message_actions.tsx';
      export { imageSrcToBase64, copyImageToClipboard } from './src/core/image_clipboard.ts';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  plugins: [{
    name: 'test-fixtures',
    setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'core', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: `
          export const invoke = (cmd, args) => globalThis.__nativeInvoke
            ? globalThis.__nativeInvoke(cmd, args)
            : Promise.reject(new Error('not in tauri'));
        `,
      }));
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
    },
  }],
});

const { getChatMessageActions, imageSrcToBase64, copyImageToClipboard } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

test('getChatMessageActions includes copy-image action only when onCopyImage is provided', () => {
  const withoutCopyImage = getChatMessageActions({
    own: false,
    onReply: () => {},
    onCopy: () => {},
    onEdit: () => {},
    onDelete: () => {},
    isFile: true,
  });
  assert.equal(withoutCopyImage.some((action) => action.id === 'copy-image'), false);

  let copied = false;
  const withCopyImage = getChatMessageActions({
    own: false,
    onReply: () => {},
    onCopy: () => {},
    onCopyImage: () => { copied = true; },
    onEdit: () => {},
    onDelete: () => {},
    isFile: true,
  });
  const copyAction = withCopyImage.find((action) => action.id === 'copy-image');
  assert.ok(copyAction);
  assert.equal(typeof copyAction.label, 'string');
  assert.ok(copyAction.label.length > 0);
  copyAction.onSelect();
  assert.equal(copied, true);
});

test('imageSrcToBase64 preserves data URLs directly without fetching', async () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const result = await imageSrcToBase64(dataUrl);
  assert.equal(result, dataUrl);
});

test('copyImageToClipboard invokes native copy_chat_image when available', async () => {
  let invokedCommand = null;
  let invokedArgs = null;
  globalThis.__nativeInvoke = async (command, args) => {
    invokedCommand = command;
    invokedArgs = args;
    return undefined;
  };

  const sampleDataUrl = 'data:image/png;base64,sample123';
  const success = await copyImageToClipboard(sampleDataUrl);
  assert.equal(success, true);
  assert.equal(invokedCommand, 'copy_chat_image');
  assert.equal(invokedArgs?.dataBase64, sampleDataUrl);
  delete globalThis.__nativeInvoke;
});
