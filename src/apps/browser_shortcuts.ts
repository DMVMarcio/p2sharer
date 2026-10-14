import type { BrowserCommand } from './browser_protocol';

interface Key { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }
export function browserShortcut(event: Key): 'address' | BrowserCommand | null {
  if (event.key === 'F6' || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') return 'address';
  if (event.key === 'F5' || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r')
    return { kind: 'reload', ignore_cache: event.key === 'F5' ? event.ctrlKey || event.shiftKey : event.shiftKey };
  if (event.key === 'BrowserBack' || event.altKey && event.key === 'ArrowLeft') return { kind: 'back' };
  if (event.key === 'BrowserForward' || event.altKey && event.key === 'ArrowRight') return { kind: 'forward' };
  return null;
}
export function browserHistoryButton(button: number): BrowserCommand | null {
  return button === 3 ? { kind: 'back' } : button === 4 ? { kind: 'forward' } : null;
}
