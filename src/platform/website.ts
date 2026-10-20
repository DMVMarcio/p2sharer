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

/** API calls can target a backend deployed separately from the website. */
export function apiUrl(path: string): string {
  const origin = import.meta.env?.VITE_PUBLIC_API_URL || (isBrowserRuntime() ? window.location.origin : 'https://api.p2sharer.com');
  const base = new URL(origin);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid public API URL');
  return new URL(path, base.origin).href;
}

export function signalingBrokerUrl(): string {
  return import.meta.env?.VITE_PUBLIC_BROKER_URL || apiUrl('/mqtt').replace(/^http/, 'ws');
}
