// Fixed native probe: no page scripts or URLs are accepted from participants.
(() => {
  let remaining = 5000;
  const scan = (root, depth = 0) => {
    if (!root || depth > 8) return false;
    for (const node of root.querySelectorAll('*')) {
      if (--remaining < 0) return false;
      if (node.tagName === 'VIDEO' && !node.paused && !node.ended && node.readyState >= 2) {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (rect.width >= 160 && rect.height >= 90 && rect.bottom > 0 && rect.right > 0 &&
            rect.top < innerHeight && rect.left < innerWidth && style.visibility !== 'hidden' &&
            style.display !== 'none' && Number(style.opacity) !== 0 && node.checkVisibility()) return true;
      }
      if (node.shadowRoot && scan(node.shadowRoot, depth + 1)) return true;
    }
    return false;
  };
  return scan(document);
})()
