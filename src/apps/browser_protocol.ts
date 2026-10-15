export const BROWSER_WIDTH = 1280;
export const BROWSER_HEIGHT = 720;
export type BrowserCursorShape = 'default' | 'text' | 'pointer';
export const validBrowserCursorShape = (value: unknown): value is BrowserCursorShape => ['default', 'text', 'pointer'].includes(String(value));
export interface BrowserTab { id: number; url: string; title: string; loading?: boolean; favicon?: string; zoom?: number; canBack?: boolean; canForward?: boolean }
export interface BrowserContext { tab: number; x: number; y: number; link: string; source: string; selection: string; editable: boolean }
export function validBrowserContext(value: unknown): value is BrowserContext {
  if (!value || typeof value !== 'object') return false;
  const menu = value as BrowserContext;
  return Number.isSafeInteger(menu.tab) && menu.tab > 0 && Number.isFinite(menu.x) && menu.x >= 0 && menu.x <= BROWSER_WIDTH
    && Number.isFinite(menu.y) && menu.y >= 0 && menu.y <= BROWSER_HEIGHT
    && [menu.link, menu.source].every(url => url === '' || typeof url === 'string' && browserUrl(url) === url)
    && typeof menu.selection === 'string' && menu.selection.length <= 8192 && typeof menu.editable === 'boolean';
}
export function validBrowserFavicon(value: unknown): boolean {
  return value === undefined || value === '' || typeof value === 'string' && value.length <= 8192
    && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}
export interface BrowserState { tabs: BrowserTab[]; active: number; temporary: boolean; serial?: number }
export interface BrowserPageDialog { id: string; tab: number; kind: 'alert' | 'confirm' | 'prompt'; message: string; defaultText: string }
export function validBrowserDialog(value: unknown): value is BrowserPageDialog {
  if (!value || typeof value !== 'object') return false;
  const d = value as BrowserPageDialog;
  return typeof d.id === 'string' && /^[a-f0-9]{32}$/.test(d.id) && Number.isSafeInteger(d.tab) && d.tab > 0
    && ['alert', 'confirm', 'prompt'].includes(d.kind) && typeof d.message === 'string' && d.message.length <= 8192
    && typeof d.defaultText === 'string' && d.defaultText.length <= 8192;
}
export type BrowserCommand =
  | { kind: 'navigate' | 'new-tab'; url: string }
  | { kind: 'select-tab' | 'close-tab'; id: number }
  | { kind: 'move-tab'; id: number; before: number | null }
  | { kind: 'reload'; ignore_cache?: boolean }
  | { kind: 'zoom'; direction: -1 | 0 | 1 }
  | { kind: 'back' | 'forward' | 'release' | 'cursor-leave' }
  | { kind: 'mouse'; event: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel'; x: number; y: number;
      button: 'none' | 'left' | 'middle' | 'right'; buttons: number; delta_x: number; delta_y: number; modifiers: number; clicks: number }
  | { kind: 'key'; event: 'keyDown' | 'keyUp'; key: string; code: string; modifiers: number; virtual_key: number }
  | { kind: 'text'; text: string };

export function browserUrl(raw: string): string | null {
  const input = raw.trim();
  if (!input || input.length > 4096) return null;
  if (input === 'about:blank') return input;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input :
    /\s/.test(input) || !input.includes('.') && !input.startsWith('localhost') ?
      `https://www.google.com/search?q=${encodeURIComponent(input)}` : `https://${input}`;
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.hostname !== 'tauri.localhost'
      && !(url.hostname === 'localhost' && url.port === '1420') ? url.href : null;
  } catch { return null; }
}
const integer = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const bounded = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
export function validBrowserCommand(value: unknown): value is BrowserCommand {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case 'navigate': case 'new-tab': return typeof v.url === 'string' && v.url.length <= 4096 && browserUrl(v.url) === v.url;
    case 'select-tab': case 'close-tab': return integer(v.id, 1_000_000);
    case 'move-tab': return integer(v.id, 1_000_000) && (v.before === null || integer(v.before, 1_000_000));
    case 'reload': return v.ignore_cache === undefined || typeof v.ignore_cache === 'boolean';
    case 'zoom': return [-1, 0, 1].includes(Number(v.direction)) && typeof v.direction === 'number';
    case 'back': case 'forward': case 'release': case 'cursor-leave': return true;
    case 'text': return typeof v.text === 'string' && v.text.length > 0 && v.text.length <= 4096;
    case 'key': return ['keyDown', 'keyUp'].includes(String(v.event)) && typeof v.key === 'string' && v.key.length <= 80
      && typeof v.code === 'string' && v.code.length <= 80 && integer(v.modifiers, 15) && integer(v.virtual_key, 255);
    case 'mouse': return ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(String(v.event))
      && bounded(v.x, BROWSER_WIDTH) && Number(v.x) >= 0 && bounded(v.y, BROWSER_HEIGHT) && Number(v.y) >= 0
      && ['none', 'left', 'middle', 'right'].includes(String(v.button)) && integer(v.buttons, 7)
      && bounded(v.delta_x, 5000) && bounded(v.delta_y, 5000) && integer(v.modifiers, 15) && integer(v.clicks, 3);
    default: return false;
  }
}
export function validBrowserState(value: unknown): value is BrowserState {
  if (!value || typeof value !== 'object') return false;
  const s = value as BrowserState;
  return typeof s.temporary === 'boolean' && (s.serial === undefined || integer(s.serial, Number.MAX_SAFE_INTEGER))
    && integer(s.active, 1_000_000) && Array.isArray(s.tabs) && s.tabs.length <= 16
    && s.tabs.every(t => t && integer(t.id, 1_000_000) && typeof t.url === 'string' && t.url.length <= 4096
      && typeof t.title === 'string' && t.title.length <= 400 && (t.loading === undefined || typeof t.loading === 'boolean') && validBrowserFavicon(t.favicon)
      && (t.zoom === undefined || typeof t.zoom === 'number' && Number.isFinite(t.zoom) && t.zoom >= 0.25 && t.zoom <= 5))
    && s.tabs.every(t => (t.canBack === undefined || typeof t.canBack === 'boolean') && (t.canForward === undefined || typeof t.canForward === 'boolean'))
    && new Set(s.tabs.map(t => t.id)).size === s.tabs.length && (!s.tabs.length || s.tabs.some(t => t.id === s.active));
}

/** Map the contained video, excluding letterbox bars, to the host's fixed viewport. */
export function browserPointerPosition(clientX: number, clientY: number,
  bounds: { left: number; top: number; width: number; height: number }, clamp = false): { x: number; y: number } | null {
  if (!(bounds.width > 0 && bounds.height > 0) || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const scale = Math.min(bounds.width / BROWSER_WIDTH, bounds.height / BROWSER_HEIGHT);
  const x = (clientX - bounds.left - (bounds.width - BROWSER_WIDTH * scale) / 2) / scale;
  const y = (clientY - bounds.top - (bounds.height - BROWSER_HEIGHT * scale) / 2) / scale;
  if (!clamp && (x < 0 || y < 0 || x > BROWSER_WIDTH || y > BROWSER_HEIGHT)) return null;
  return { x: Math.max(0, Math.min(BROWSER_WIDTH, x)), y: Math.max(0, Math.min(BROWSER_HEIGHT, y)) };
}

/** The browser host is the only clock and arbiter. Held gestures expire on lost input. */
export class BrowserControlLease {
  owner = '';
  touched = 0;
  buttons = 0;
  keys = new Map<string, Extract<BrowserCommand, { kind: 'key' }>>();
  readonly host: string;
  constructor(host: string) { this.host = host; }
  expired(now: number): boolean { return now - this.touched >= (this.buttons || this.keys.size ? 10_000 : 1000); }
  accepts(actor: string, now: number): boolean { return !this.owner || actor === this.owner || actor === this.host || this.expired(now); }
  update(actor: string, command: BrowserCommand, now: number): void {
    this.owner = actor; this.touched = now;
    if (command.kind === 'mouse') this.buttons = command.buttons;
    if (command.kind === 'key') {
      if (command.event === 'keyDown') this.keys.set(command.code, command);
      else this.keys.delete(command.code);
    }
  }
  clear(): void { this.owner = ''; this.buttons = 0; this.keys.clear(); }
}
export const BROWSER_HOME = 'https://www.google.com/';
