// The offscreen page must never capture the host's physical mouse. The shell
// captures the controlling participant and forwards bounded relative movement.
(() => {
  let target = null;
  let gesture = 0;
  const report = () => globalThis[__P2SHARER_CURSOR_BINDING__]?.(target ? 'locked' : 'unlocked');
  const changed = () => { report(); document.dispatchEvent(new Event('pointerlockchange')); };
  for (const type of ['mousedown', 'keydown']) document.addEventListener(type, event => {
    if (event.isTrusted) gesture = performance.now();
  }, true);
  Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: true, get: () => target });
  Element.prototype.requestPointerLock = function () {
    if (!this.isConnected || !gesture || performance.now() - gesture > 1500) {
      document.dispatchEvent(new Event('pointerlockerror'));
      return Promise.reject(new DOMException('Interact with the page first', 'NotAllowedError'));
    }
    gesture = 0; target = this; queueMicrotask(changed); return Promise.resolve();
  };
  document.exitPointerLock = () => { if (target) { target = null; changed(); } };
  Object.defineProperty(globalThis, '__p2sharerRelativeMouse', { value: (dx, dy) => {
    if (!target?.isConnected) { document.exitPointerLock(); return; }
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 5000 || Math.abs(dy) > 5000) return;
    const options = { bubbles: true, movementX: dx, movementY: dy, view: window };
    if (typeof PointerEvent === 'function') target.dispatchEvent(new PointerEvent('pointermove', { ...options, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mousemove', options));
  } });
  new MutationObserver(() => { if (target && !target.isConnected) document.exitPointerLock(); }).observe(document, { childList: true, subtree: true });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') document.exitPointerLock(); }, true);
  window.addEventListener('pagehide', () => document.exitPointerLock());
  report();
})();
