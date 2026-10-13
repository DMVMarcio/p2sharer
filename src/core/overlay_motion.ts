export type OverlayFamily = 'dialog' | 'menu';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/** Read the same duration tokens used by CSS and retained-content lifetimes. */
export function overlayMotionDuration(family: OverlayFamily, opening: boolean): number {
  if (prefersReducedMotion()) return 0;
  const fallback = family === 'dialog' ? (opening ? 280 : 240) : (opening ? 320 : 260);
  if (typeof window === 'undefined' || typeof document === 'undefined' || !window.getComputedStyle) return fallback;
  const value = window.getComputedStyle(document.documentElement)
    .getPropertyValue(`--${family === 'menu' ? 'dropdown' : 'dialog'}-${opening ? 'enter' : 'exit'}-duration`).trim();
  if (!/^\d+(?:\.\d+)?(?:ms|s)$/.test(value)) return fallback;
  return parseFloat(value) * (value.endsWith('ms') ? 1 : 1000);
}
