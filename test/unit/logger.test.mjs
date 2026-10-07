import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement']) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const records = [];
globalThis.loggerFixture = { records, fail: false };
const originals = Object.fromEntries(['log', 'info', 'warn', 'error'].map(key => [key, console[key]]));
for (const key of Object.keys(originals)) console[key] = () => {};
const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `export * from './src/core/logger.ts';
export { MediaCoordinator } from './src/p2p/media_coordinator.ts';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'ipc', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'ipc', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const invoke = async (command, args) => {
      if (globalThis.loggerFixture.fail) throw new Error('IPC unavailable');
      globalThis.loggerFixture.records.push({ command, ...args });
    }; export const isTauri = () => false;` }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { initFrontendLogger, reactErrorHandlers, logDiagnostic, formatLogValue, MediaCoordinator } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'), reactErrorHandlers);
after(async () => {
  await act(async () => root.unmount());
  for (const [key, method] of Object.entries(originals)) console[key] = method;
  delete globalThis.loggerFixture;
  dom.window.close();
});

test('session logging captures React component failures, native error fields and global errors without duplicate initialization', async () => {
  initFrontendLogger(); initFrontendLogger();
  assert.equal(records.filter(record => record.context === 'frontend.startup').length, 1);
  const cause = Object.assign(new Error('Unsupported device mode'), { name: 'OverconstrainedError', constraint: 'frameRate' });
  const failure = new Error('Render failed', { cause });
  class Boundary extends React.Component {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() { return this.state.failed ? React.createElement('p', null, 'Recovered') : this.props.children; }
  }
  function BrokenCamera() { throw failure; }
  await act(async () => root.render(React.createElement(Boundary, null, React.createElement(BrokenCamera))));
  const caught = records.find(record => record.context === 'react.caught');
  assert.ok(caught.message.includes('BrokenCamera'));
  assert.ok(caught.message.includes('Render failed'));
  assert.ok(caught.message.includes('OverconstrainedError'));
  assert.ok(caught.message.includes('Constraint: frameRate'));
  assert.ok(caught.message.includes('Stack:'));
  window.dispatchEvent(new window.ErrorEvent('error', { message: 'Script failed', error: failure, filename: 'bundle.js', lineno: 12, colno: 4 }));
  assert.equal(records.filter(record => record.context === 'window.error').length, 1);
  console.info('[Video] Encoder selected', { codec: 'video/VP8' });
  console.log('Unrelated frequent tick');
  assert.equal(records.filter(record => record.message.includes('Encoder selected')).length, 1);
  assert.equal(records.filter(record => record.message.includes('frequent tick')).length, 0);
  cause.cause = failure;
  assert.ok(formatLogValue({ error: failure }).includes('[Circular]'));
  const event = new window.Event('unhandledrejection');
  Object.defineProperty(event, 'reason', { value: failure });
  window.dispatchEvent(event);
  assert.equal(records.filter(record => record.context === 'window.unhandledrejection').length, 1);
  globalThis.loggerFixture.fail = true;
  logDiagnostic('ERROR', 'test', 'Logging during native shutdown', failure);
  await new Promise(resolve => setImmediate(resolve));
  globalThis.loggerFixture.fail = false;
});

test('actual encoder reports are logged once per selection and cannot be mistaken for capability preferences', () => {
  const sender = { track: { id: 'video-track' } };
  const reports = new Map([
    ['rtp', { type: 'outbound-rtp', kind: 'video', framesEncoded: 0, codecId: 'codec' }],
    ['codec', { mimeType: 'video/VP8' }],
  ]);
  MediaCoordinator.logSenderEncoder(sender, reports, 'media-session');
  assert.equal(records.filter(record => record.context === 'transmission.encoder').length, 0);
  reports.get('rtp').framesEncoded = 3;
  MediaCoordinator.logSenderEncoder(sender, reports, 'media-session');
  MediaCoordinator.logSenderEncoder(sender, reports, 'media-session');
  assert.equal(records.filter(record => record.context === 'transmission.encoder').length, 1);
  assert.ok(records.at(-1).message.includes('unreported by WebView2'));
  reports.get('rtp').encoderImplementation = 'Software encoder';
  MediaCoordinator.logSenderEncoder(sender, reports, 'media-session');
  assert.equal(records.filter(record => record.context === 'transmission.encoder').length, 2);
});
