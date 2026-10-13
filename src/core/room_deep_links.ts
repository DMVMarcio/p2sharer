const INVITE_CODE = /^p2s[345]\.[A-Za-z0-9_-]{200,30000}$/;
const INVITE_LINK = /^p2sharer:\/\/(?:invite|convite)\/(p2s[345]\.[A-Za-z0-9_-]{200,30000})$/i;

/** Keep the case-sensitive invitation in the path, never in the URL host. */
export function extractRoomInvite(value: string): string | null {
  const text = value.trim();
  if (INVITE_CODE.test(text)) return text;
  const code = INVITE_LINK.exec(text)?.[1];
  return code && INVITE_CODE.test(code) ? code : null;
}

export function roomInviteLink(code: string): string {
  const invite = extractRoomInvite(code);
  return invite ? `p2sharer://invite/${invite}` : '';
}

/** Retain the latest invitation until profile setup or another dialog finishes. */
export class RoomDeepLinkInbox {
  private pending: string | null = null;
  private readonly open: (invite: string) => void;
  private readonly ready: () => boolean;

  constructor(open: (invite: string) => void, ready: () => boolean) {
    this.open = open;
    this.ready = ready;
  }

  receive(urls: string[]): void {
    for (const url of urls) {
      if (!/^p2sharer:\/\//i.test(url)) continue;
      const invite = extractRoomInvite(url);
      if (invite) this.pending = invite;
    }
    this.flush();
  }

  flush(): void {
    if (!this.pending || !this.ready()) return;
    const invite = this.pending;
    this.pending = null;
    this.open(invite);
  }
}
