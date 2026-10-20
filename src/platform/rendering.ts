/** Let urgent navigation feedback paint before evaluating a large lazy route. */
export function waitForNavigationPaint(): Promise<void> {
  return new Promise(resolve => {
    let frame: number | undefined;
    let task: number | undefined;
    const finish = () => {
      window.clearTimeout(fallback);
      window.clearTimeout(task);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      resolve();
    };
    // Hidden tabs may suspend animation frames; never hold navigation indefinitely.
    const fallback = window.setTimeout(finish, 100);
    if (typeof window.requestAnimationFrame === 'function') {
      frame = window.requestAnimationFrame(() => { task = window.setTimeout(finish, 0); });
    } else task = window.setTimeout(finish, 0);
  });
}
