import { roomCodeFromPath } from '../core/web_room_links.ts';
import { roomInviteLink } from '../core/room_deep_links.ts';

const attempts = new WeakMap<Document, Set<string>>();

/** External protocols have no reliable installation check; always leave the web app usable. */
export function tryDesktopRoomInvite(pathname: string): () => void {
  const code = roomCodeFromPath(pathname);
  if (!code || '__TAURI_INTERNALS__' in window) return () => {};
  let frame: HTMLIFrameElement | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  // Defer dispatch so StrictMode's discarded effect cannot consume the attempt.
  const timer = setTimeout(() => {
    const seen = attempts.get(document) ?? new Set<string>();
    if (seen.has(code) || window.location.pathname !== pathname) return;
    seen.add(code); attempts.set(document, seen);
    try {
      frame = document.createElement('iframe');
      frame.hidden = true; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true');
      frame.src = roomInviteLink(code);
      document.body.append(frame);
      expiry = setTimeout(() => frame?.remove(), 30_000);
    } catch { frame?.remove(); }
  }, 0);
  return () => { clearTimeout(timer); clearTimeout(expiry); frame?.remove(); };
}
