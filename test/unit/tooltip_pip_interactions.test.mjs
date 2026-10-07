import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const browser = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node']) globalThis[key] = browser.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const frames = new Map();
let frameId = 0;
globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
globalThis.pipDragCalls = 0;
const require = createRequire(import.meta.url);
const bundle = await build({ stdin: {
  contents: "export * from './src/components/common/Tooltip.tsx'; export * from './src/hooks/usePipWindowDrag.ts';",
  resolveDir: process.cwd(),
}, bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', plugins: [{ name: 'dependencies', setup(builder) {
  builder.onResolve({ filter: /^@tauri-apps\/api\/(core|window)$/ }, args => ({ path: args.path, namespace: 'desktop' }));
  builder.onLoad({ filter: /.*/, namespace: 'desktop' }, args => ({ contents: args.path.endsWith('/core')
    ? 'export const isTauri = () => true;'
    : 'export const getCurrentWindow = () => ({ startDragging: async () => { globalThis.pipDragCalls++; } });' }));
  builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
} }] });
const { Tooltip, usePipWindowDrag } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
let transitions = [];
let anchorX = 10;
let anchorScale = 1;
function Fixture({ disabled = false, interactive = false, content = 'Action', callback = open => transitions.push(open) }) {
  return React.createElement('div', null,
    React.createElement(Tooltip, { content, disabled, interactive, showDelay: 1, hideDelay: 5, onOpenChange: callback },
      React.createElement('button', { id: 'trigger', ref: node => {
        if (node) node.getBoundingClientRect = () => {
          const size = 30 * anchorScale;
          const x = anchorX + (30 - size) / 2;
          const y = 10 + (30 - size) / 2;
          return { x, y, left: x, right: x + size, top: y, bottom: y + size, width: size, height: size };
        };
      } }, 'Action')),
    React.createElement('button', { id: 'outside' }, 'Other'));
}
const render = async props => act(async () => root.render(React.createElement(Fixture, props)));
const dispatch = async (target, name, options = {}) => act(async () => target.dispatchEvent(new window.MouseEvent(name, { bubbles: true, ...options })));
const wait = async () => act(async () => new Promise(resolve => setTimeout(resolve, 15)));
const trigger = () => document.getElementById('trigger');
const tooltip = () => document.querySelector('[role="tooltip"]');
const hover = async () => { await dispatch(trigger(), 'mouseover', { relatedTarget: document.body }); await wait(); assert.ok(tooltip()); };
beforeEach(async () => {
  await act(async () => root.render(null));
  transitions = []; anchorX = 10; anchorScale = 1; frames.clear(); globalThis.pipDragCalls = 0;
  await render();
});
after(async () => { await act(async () => root.unmount()); browser.window.close(); });

test('click dismisses without reopening on mouse focus, and pending hover is canceled', async () => {
  await hover();
  await dispatch(trigger(), 'pointerdown');
  await act(async () => trigger().focus());
  await dispatch(trigger(), 'click');
  await wait();
  assert.equal(tooltip(), null);
  assert.deepEqual(transitions, [true, false]);
  await dispatch(trigger(), 'mouseout', { relatedTarget: document.body });
  await dispatch(trigger(), 'mouseover', { relatedTarget: document.body });
  await dispatch(trigger(), 'pointerdown');
  await wait();
  assert.equal(tooltip(), null);
});

test('window exit, blur, scroll and Escape close tooltips, including pending shows', async () => {
  for (const dismiss of [
    () => dispatch(document, 'mouseout', { relatedTarget: null }),
    () => act(async () => window.dispatchEvent(new window.Event('blur'))),
    () => act(async () => window.dispatchEvent(new window.Event('scroll'))),
    () => act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))),
  ]) {
    await hover(); await dismiss(); assert.equal(tooltip(), null);
    await dispatch(trigger(), 'mouseover', { relatedTarget: document.body });
    await dismiss(); await wait(); assert.equal(tooltip(), null);
  }
});

test('layout movement and disabled content dismiss without duplicate visibility notifications', async () => {
  await hover();
  await render({ callback: open => transitions.push(open) });
  assert.deepEqual(transitions, [true]);
  anchorX = 70;
  await act(async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); });
  assert.equal(tooltip(), null);
  assert.deepEqual(transitions, [true, false]);
  await hover(); await render({ disabled: true });
  assert.equal(tooltip(), null);
  assert.deepEqual(transitions, [true, false, true, false]);
});

test('hover animation keeps the tooltip open, while actual anchor movement still dismisses it', async () => {
  await hover();
  for (const scale of [1.1, 1.18]) {
    anchorScale = scale;
    await act(async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); });
    assert.ok(tooltip());
  }
  anchorX = 70;
  await act(async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); });
  assert.equal(tooltip(), null);
});

test('pointer dialog focus restoration does not reopen a tooltip; hover and keyboard navigation still work', async () => {
  await hover();
  await dispatch(trigger(), 'pointerdown');
  await act(async () => document.getElementById('outside').focus());
  await dispatch(document.getElementById('outside'), 'pointerdown');
  await dispatch(document.getElementById('outside'), 'click');
  await act(async () => trigger().focus());
  await wait();
  assert.equal(tooltip(), null);
  await hover();
  await dispatch(trigger(), 'mouseout', { relatedTarget: document.body });
  await wait();
  assert.equal(tooltip(), null, 'A pointer-restored focus must not retain the hover tooltip');
  await act(async () => document.getElementById('outside').focus());
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
  await act(async () => trigger().focus());
  await wait();
  assert.ok(tooltip());
});

test('keyboard focus and interactive tooltip hover remain usable; unmount closes once', async () => {
  await act(async () => trigger().focus()); await wait(); assert.ok(tooltip());
  await act(async () => document.getElementById('outside').focus()); await wait(); assert.equal(tooltip(), null);
  await render({ interactive: true }); await hover();
  const panel = tooltip();
  await dispatch(trigger(), 'mouseout', { relatedTarget: panel });
  await dispatch(panel, 'mouseover', { relatedTarget: trigger() }); await wait(); assert.ok(tooltip());
  await act(async () => panel.dispatchEvent(new window.Event('scroll')));
  assert.ok(tooltip(), 'Scrolling an interactive list must not dismiss its tooltip');
  await dispatch(panel, 'pointerdown'); await dispatch(panel, 'click');
  assert.ok(tooltip(), 'Interacting with a scrollbar must not remove the panel');
  await act(async () => root.render(null));
  assert.deepEqual(transitions, [true, false, true, false]);
});

test('actions inside interactive tooltip content can complete before dismissal', async () => {
  let activated = 0;
  await render({ interactive: true, content: React.createElement('button', { id: 'panel-action', onClick: () => activated++ }, 'Open') });
  await hover();
  await dispatch(document.getElementById('panel-action'), 'pointerdown');
  assert.ok(tooltip());
  await act(async () => document.getElementById('panel-action').click());
  assert.equal(activated, 1);
  assert.equal(tooltip(), null);
});

function DragFixture({ enabled = true }) {
  const drag = usePipWindowDrag(enabled);
  return React.createElement('div', { id: 'pip', onPointerDownCapture: drag },
    React.createElement('video', { id: 'video' }), React.createElement('button', { id: 'control' }, 'Control'),
    React.createElement('input', { id: 'range', type: 'range' }));
}
test('PiP drags from video and empty areas after movement, while controls and clicks stay usable', async () => {
  await act(async () => root.render(React.createElement(DragFixture)));
  for (const selector of ['#video', '#pip']) {
    await dispatch(document.querySelector(selector), 'pointerdown', { clientX: 30, clientY: 40, button: 0 });
    await dispatch(window, 'pointermove', { clientX: 31, clientY: 41 });
    const previous = globalThis.pipDragCalls;
    await dispatch(window, 'pointermove', { clientX: 50, clientY: 60 });
    assert.equal(globalThis.pipDragCalls, previous + 1);
  }
  for (const selector of ['#control', '#range']) {
    await dispatch(document.querySelector(selector), 'pointerdown'); await dispatch(window, 'pointermove', { clientX: 50 });
  }
  assert.equal(globalThis.pipDragCalls, 2);
  await dispatch(document.querySelector('#video'), 'pointerdown'); await dispatch(window, 'pointerup');
  await dispatch(window, 'pointermove', { clientX: 50 }); assert.equal(globalThis.pipDragCalls, 2);
});

test('PiP drag cancellation, disabled interaction and unmount never leave a pending native drag', async () => {
  await act(async () => root.render(React.createElement(DragFixture)));
  await dispatch(document.querySelector('#video'), 'pointerdown'); await dispatch(window, 'pointercancel');
  await dispatch(window, 'pointermove', { clientX: 100 }); assert.equal(globalThis.pipDragCalls, 0);
  await act(async () => root.render(React.createElement(DragFixture, { enabled: false })));
  await dispatch(document.querySelector('#video'), 'pointerdown'); await dispatch(window, 'pointermove', { clientX: 100 });
  assert.equal(globalThis.pipDragCalls, 0);
  await act(async () => root.render(React.createElement(DragFixture)));
  await dispatch(document.querySelector('#video'), 'pointerdown'); await act(async () => root.render(null));
  await dispatch(window, 'pointermove', { clientX: 100 }); assert.equal(globalThis.pipDragCalls, 0);
});
