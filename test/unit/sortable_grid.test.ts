import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useSortableGrid } from '../../src/hooks/useSortableGrid.ts';

test('grid drag previews order, Escape cancels, drop commits, and keyboard preserves focus', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const old = new Map<string, PropertyDescriptor | undefined>();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  };
  for (const [key, value] of Object.entries(globals)) {
    old.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let reducedMotion = false;
  dom.window.matchMedia = () => ({ matches: reducedMotion }) as MediaQueryList;
  let animationCount = 0;
  const prototype = dom.window.HTMLElement.prototype;
  Object.defineProperties(prototype, {
    offsetLeft: { get() { return Array.from(this.parentElement?.children || []).indexOf(this) % 2 * 220; } },
    offsetTop: { get() { return Math.floor(Array.from(this.parentElement?.children || []).indexOf(this) / 2) * 120; } },
    offsetWidth: { get() { return 200; } }, offsetHeight: { get() { return 100; } },
  });
  prototype.getBoundingClientRect = function () {
    const card = this.hasAttribute('data-sortable-id');
    const left = card ? this.offsetLeft : 0;
    const top = card ? this.offsetTop : 0;
    return { x: left, y: top, left, top, width: 200, height: 100, right: left + 200,
      bottom: top + 100, toJSON() {} } as DOMRect;
  };
  prototype.setPointerCapture = () => {};
  prototype.hasPointerCapture = () => false;
  prototype.animate = () => {
    animationCount++;
    return { cancel() {}, onfinish: null } as unknown as Animation;
  };
  const commits: string[][] = [];
  let manualPlacement = false;
  const drops: Array<{ id: string; x: number; y: number }> = [];
  function Fixture() {
    const sort = useSortableGrid(['a', 'b', 'c', 'd'], (ids) => { commits.push(ids); }, manualPlacement ? {
      preview: false,
      onDrop: (id, x, y, order) => { drops.push({ id, x, y }); return order; },
    } : {});
    return React.createElement('div', { ref: sort.gridRef, style: { '--transition-normal': '0.22s cubic-bezier(0.16, 1, 0.3, 1)' } }, sort.order.map((id) =>
      React.createElement('article', { key: id, ref: sort.cardRef(id), 'data-sortable-id': id },
        React.createElement('button', { ...sort.handleProps(id), 'data-handle': id }, id))));
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  const order = () => [...dom.window.document.querySelectorAll('article')].map((node) => node.getAttribute('data-sortable-id'));
  const handle = () => dom.window.document.querySelector<HTMLButtonElement>('[data-handle="a"]')!;
  const pointer = (type: string, target: EventTarget, x: number, y: number) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y });
    target.dispatchEvent(event);
  };
  const step = async () => act(() => {
    const current = [...frames.values()]; frames.clear(); current.forEach((callback) => callback(0));
  });
  try {
    await act(() => root.render(React.createElement(Fixture)));
    await act(() => pointer('pointerdown', handle(), 10, 10));
    await act(() => pointer('pointermove', dom.window, 230, 130));
    await step();
    assert.deepEqual(order(), ['b', 'c', 'd', 'a']);
    assert.ok(animationCount > 0);
    assert.equal(commits.length, 0);
    await act(() => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })));
    assert.deepEqual(order(), ['a', 'b', 'c', 'd']);
    assert.equal(commits.length, 0);
    await act(() => pointer('pointerdown', handle(), 10, 10));
    await act(() => pointer('pointermove', dom.window, 230, 10));
    await step();
    await act(() => pointer('pointerup', dom.window, 230, 10));
    assert.deepEqual(commits, [['b', 'a', 'c', 'd']]);
    handle().focus();
    await act(() => handle().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    assert.deepEqual(order(), ['b', 'c', 'd', 'a']);
    assert.equal(dom.window.document.activeElement, handle());
    reducedMotion = true;
    const before = animationCount;
    await act(() => handle().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    assert.deepEqual(order(), ['a', 'b', 'c', 'd']);
    assert.equal(animationCount, before);
    manualPlacement = true;
    await act(() => root.render(React.createElement(Fixture)));
    await act(() => pointer('pointerdown', handle(), 10, 10));
    await act(() => pointer('pointermove', dom.window, 230, 130));
    await step();
    assert.deepEqual(order(), ['a', 'b', 'c', 'd']);
    await act(() => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })));
    assert.equal(drops.length, 0);
    const commitCount = commits.length;
    await act(() => pointer('pointerdown', handle(), 10, 10));
    await act(() => pointer('pointermove', dom.window, 230, 130));
    await step();
    await act(() => pointer('pointerup', dom.window, 230, 130));
    assert.deepEqual(drops, [{ id: 'a', x: 320, y: 170 }]);
    // Row membership can change even when the flattened order remains the same.
    assert.equal(commits.length, commitCount + 1);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
