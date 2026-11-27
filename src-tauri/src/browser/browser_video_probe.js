// Fixed native probe: no page scripts or URLs are accepted from participants.
(() => {
  let remaining = 5000;
  const scan = (root, depth = 0) => {
    if (!root || depth > 8) return false;
    for (const node of root.querySelectorAll('*')) {
      if (--remaining < 0) return false;
      const playing = node.tagName === 'VIDEO' && !node.paused && !node.ended && node.readyState >= 2;
      // A prominent canvas covers WebGL/2D games without creating a rendering context
      // or reading pixels that can be protected or cleared between GPU frames.
      const graphics = node.tagName === 'CANVAS' && node.width >= 320 && node.height >= 180;
      if (playing || graphics) {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (rect.width >= 160 && rect.height >= 90 && rect.bottom > 0 && rect.right > 0 &&
            rect.top < innerHeight && rect.left < innerWidth && style.visibility !== 'hidden' &&
            style.display !== 'none' && Number(style.opacity) !== 0 && node.checkVisibility()
            && (!graphics || rect.width * rect.height >= innerWidth * innerHeight * 0.2)) return true;
      }
      if (node.shadowRoot && scan(node.shadowRoot, depth + 1)) return true;
    }
    return false;
  };
  return scan(document);
})()
