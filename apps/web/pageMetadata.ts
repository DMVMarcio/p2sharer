import { useEffect } from 'react';

function canonicalUrl(path: string): string {
  const origin = import.meta.env?.VITE_PUBLIC_SITE_URL || window.location.origin;
  return new URL(path, origin).href;
}

function setMeta(attribute: 'name' | 'property', key: string, content: string): void {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, key);
    document.head.append(element);
  }
  element.content = content;
}

function setCanonical(href: string): void {
  let element = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!element) {
    element = document.createElement('link');
    element.rel = 'canonical';
    document.head.append(element);
  }
  element.href = href;
}

/**
 * Keeps the document title, description, canonical URL and social preview tags in sync
 * with the current site page and language. The static index.html carries the defaults
 * used by crawlers that do not run scripts.
 */
export function usePageMetadata(title: string, description: string, path: string): void {
  useEffect(() => {
    const url = canonicalUrl(path);
    document.title = title;
    setMeta('name', 'description', description);
    setMeta('property', 'og:title', title);
    setMeta('property', 'og:description', description);
    setMeta('property', 'og:url', url);
    setMeta('name', 'twitter:title', title);
    setMeta('name', 'twitter:description', description);
    setCanonical(url);
  }, [description, path, title]);
}
