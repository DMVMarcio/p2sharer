import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act, useRef } from 'react';

test('fullscreen controls hide after idle, reveal on movement and retain active keyboard controls', async context => {
  const require = createRequire(import.meta.url);
  const bundle = await build({ stdin: { contents: "export { useIdleControls } from './src/hooks/useIdleControls';", resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'idle-controls-fixture', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }] });
  const { useIdleControls } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = ['window','document','HTMLElement','Element','Node','IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys.slice(0,-1)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const Harness = () => {
    const controls = useIdleControls(true, 50);
    return React.createElement('div', null,
      React.createElement('div', { id: 'controls', inert: !controls.visible }, 'Controls'),
      React.createElement('button', { id: 'move', onClick: controls.reveal }, 'Move'),
      React.createElement('button', { id: 'hold', onClick: () => controls.hold('focus') }, 'Focus'),
      React.createElement('button', { id: 'release', onClick: () => controls.release('focus') }, 'Blur'));
  };
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => context.mock.timers.tick(51));
    assert.equal(document.getElementById('controls').hasAttribute('inert'), true);
    await act(async () => document.getElementById('move').click());
    assert.equal(document.getElementById('controls').hasAttribute('inert'), false);
    await act(async () => document.getElementById('hold').click());
    await act(async () => context.mock.timers.tick(100));
    assert.equal(document.getElementById('controls').hasAttribute('inert'), false);
    await act(async () => document.getElementById('release').click());
    await act(async () => context.mock.timers.tick(51));
    assert.equal(document.getElementById('controls').hasAttribute('inert'), true);
  } finally {
    await act(async () => root.unmount()); context.mock.timers.reset(); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test('fullscreen remains operable under StrictMode and uses the canonical dialog close lifecycle', async () => {
  const require = createRequire(import.meta.url);
  const bundle = await build({ stdin: { contents: `
    export { useNativeFullscreen } from './src/hooks/useNativeFullscreen';
    export { FullscreenDialog } from './src/components/common/FullscreenDialog';`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
    plugins: [{ name: 'native-fullscreen-fixture', setup(builder) {
      builder.onResolve({filter:/^@tauri-apps\/api\/(core|window)$/}, args => ({path:args.path, namespace:'fixture'}));
      builder.onLoad({filter:/.*/, namespace:'fixture'}, args => ({contents: args.path.endsWith('/window')
        ? 'export const getCurrentWindow = () => globalThis.nativeFullscreenFixture;'
        : 'export const isTauri = () => true; export const invoke = async () => undefined;'}));
      builder.onResolve({filter:/^[^./]/}, args => ({path:pathToFileURL(require.resolve(args.path)).href, external:true}));
    } }] });
  const { useNativeFullscreen, FullscreenDialog } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const dom = new JSDOM('<div id="root"></div>', {pretendToBeVisual:true});
  const keys = ['window','document','HTMLElement','Element','Node','MutationObserver','IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for (const key of keys.slice(0,-1)) Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const values = [];
  let failExit = false;
  globalThis.nativeFullscreenFixture = {isFullscreen:async()=>false,setFullscreen:async value=>{
    values.push(value); if (!value && failExit) { failExit = false; throw new Error('Fixture native exit failure'); }
  }};
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  let remoteTabs = 0;
  const Harness = () => {
    const {fullscreen,enterFullscreen,exitFullscreen} = useNativeFullscreen();
    const closeRef = useRef(null);
    return React.createElement(React.Fragment,null,
      React.createElement('button',{id:'enter',onClick:enterFullscreen},'Enter'),
      fullscreen && React.createElement(FullscreenDialog,{title:'Browser',closeRef,onClose:exitFullscreen},
        React.createElement('button',{id:'exit',onClick:()=>closeRef.current?.()},'Exit'),
        React.createElement('textarea',{id:'remote-input','data-remote-keyboard':true,onKeyDown:e=>{if(e.key==='Tab'){e.preventDefault();remoteTabs++;}}})));
  };
  try {
    await act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(Harness))));
    await act(async()=>document.getElementById('enter').click());
    assert.deepEqual(values,[true]); assert.ok(document.querySelector('.fullscreen-dialog'));
    const input = document.getElementById('remote-input'); input.focus();
    await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})));
    assert.equal(remoteTabs,1); assert.equal(document.activeElement,input);
    failExit = true;
    await act(async()=>document.getElementById('exit').click());
    await act(async()=>new Promise(resolve=>setTimeout(resolve,280)));
    assert.equal(document.querySelector('.fullscreen-dialog').hasAttribute('inert'),false, 'failed native exits keep the browser operable');
    await act(async()=>document.getElementById('exit').click());
    assert.equal(document.querySelector('.fullscreen-dialog').hasAttribute('inert'),true);
    await act(async()=>new Promise(resolve=>setTimeout(resolve,280)));
    assert.equal(document.querySelector('.fullscreen-dialog'),null); assert.deepEqual(values,[true,false,false]);
    await act(async()=>document.getElementById('enter').click());
    await act(async()=>root.unmount()); assert.deepEqual(values,[true,false,false,true,false]);
  } finally {
    await act(async()=>root.unmount()); dom.window.close(); delete globalThis.nativeFullscreenFixture;
    for (const [key,descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key); }
  }
});
