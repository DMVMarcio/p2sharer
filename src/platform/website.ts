export function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.location?.origin) && !('__TAURI_INTERNALS__' in window);
}

/** Browser links stay on their current origin; desktop builds can pin the public website. */
export function websiteUrl(path: string): string {
  const browser = isBrowserRuntime();
  const origin = browser ? window.location.origin : import.meta.env?.VITE_PUBLIC_SITE_URL ||
    (import.meta.env?.DEV ? 'http://localhost:1422' : 'https://p2sharer.com');
  const base = new URL(origin);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid public website URL');
  return new URL(path, base.origin).href;
}
