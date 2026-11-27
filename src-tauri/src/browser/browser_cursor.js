(() => {
  let point = null;
  let scheduled = false;
  const shapeAt = (x, y) => {
    let element = document.elementFromPoint(x, y);
    for (let depth = 0; element?.shadowRoot && depth < 8; depth++) {
      const child = element.shadowRoot.elementFromPoint(x, y);
      if (!child || child === element) break;
      element = child;
    }
    if (!element) return 'default';
    const style = getComputedStyle(element);
    if (['text', 'vertical-text'].includes(style.cursor)) return 'text';
    if (style.cursor === 'pointer') return 'pointer';
    if (element.closest('a[href],button:not(:disabled),[role="button"],[role="link"],summary,input[type="button"],input[type="submit"],input[type="checkbox"],input[type="radio"]')) return 'pointer';
    if (element.isContentEditable || element.matches('textarea:not(:disabled)') || element.matches('input:not(:disabled)')
      && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(element.type)) return 'text';
    if (style.userSelect === 'none') return 'default';
    const caret = document.caretRangeFromPoint?.(x, y);
    if (caret?.startContainer.nodeType === Node.TEXT_NODE && caret.startContainer.textContent?.trim()) {
      const length = caret.startContainer.textContent.length;
      const offset = Math.min(caret.startOffset, length - 1);
      caret.setStart(caret.startContainer, offset);
      caret.setEnd(caret.startContainer, offset + 1);
      for (const rect of caret.getClientRects()) if (x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top && y <= rect.bottom) return 'text';
    }
    return 'default';
  };
  const schedule = () => {
    if (scheduled || !point) return;
    scheduled = true;
    // Offscreen page rendering may pause animation frames; cursor feedback must not.
    queueMicrotask(() => {
      scheduled = false;
      const report = globalThis[__P2SHARER_CURSOR_BINDING__];
      if (!point || typeof report !== 'function') return;
      report(shapeAt(point.x, point.y));
    });
  };
  document.addEventListener('mousemove', event => {
    if (!event.isTrusted) return;
    point = { x: event.clientX, y: event.clientY }; schedule();
  }, { capture: true, passive: true });
  document.addEventListener('scroll', schedule, { capture: true, passive: true });
})();
