import { profileImages, PROFILE_CHUNK, PROFILE_MAX_BYTES, validProfileColor, validProfileHash } from '../core/profile_image.ts';

type Send = (packet: unknown, peerId: string) => Promise<unknown> | unknown;
interface Offer { hash: string; size: number; color: string; cardColor?: string; bannerEnabled?: boolean; bannerBlur?: boolean }
interface Pending { offer: Offer; token: string; parts: string[]; length: number; until: number; validating: boolean }

// Offers grant no permission to send image bytes. Only a matching, unexpired
// request token permits a bounded sequence, and native validation gates display.
export class ProfileTransfer {
  private offers = new Map<string, Offer>();
  private pending = new Map<string, Pending>();
  private lastOffer = new Map<string, number>();
  private deferred = new Map<string, Offer>();
  private lastSend = new Map<string, { at: number; hash: string }>();
  private sending = new Set<string>();
  private queuedSends = new Map<string, unknown>();
  private closed = false;
  private attempts = new Map<string, { hash: string; count: number }>();
  private send: Send;
  private authorized: (peerId: string) => boolean;
  private images: typeof profileImages;
  private timer = setInterval(() => {
    for (const [peer, request] of this.pending) if (request.until < Date.now()) this.pending.delete(peer);
    for (const [peer, offer] of this.deferred) {
      this.deferred.delete(peer);
      void this.receive({ kind: 'offer', ...offer }, peer).catch(() => {});
    }
    this.requestWaiting();
  }, 5000);
  constructor(send: Send, authorized: (peerId: string) => boolean, images = profileImages) {
    this.send = send; this.authorized = authorized; this.images = images;
    // Node regression runners should not remain alive for browser housekeeping.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
  private requestWaiting() {
    if (this.closed) return;
    for (const [peerId, offer] of this.offers) {
      if (!this.authorized(peerId) || !offer.hash || this.images.has(offer.hash) || this.pending.has(peerId) ||
        [...this.pending.values()].some(p => p.offer.hash === offer.hash) || this.pending.size >= 4) continue;
      const attempts = this.attempts.get(peerId);
      if (attempts?.hash === offer.hash && attempts.count >= 2) continue;
      this.attempts.set(peerId, { hash: offer.hash, count: attempts?.hash === offer.hash ? attempts.count + 1 : 1 });
      const token = crypto.randomUUID();
      this.pending.set(peerId, { offer, token, parts: [], length: 0, until: Date.now() + 60000, validating: false });
      void Promise.resolve(this.send({ kind: 'request', hash: offer.hash, token }, peerId)).catch(() => {});
    }
  }
  async announce(peerId: string) {
    await this.images.ready;
    if (this.closed || !this.authorized(peerId)) return;
    const { hash, data, color, bannerEnabled, bannerBlur } = this.images.local;
    await this.send({ kind: 'offer', hash, size: data.length, color, cardColor: this.images.background('local'),
      ...(this.images.banner ? { bannerEnabled: bannerEnabled !== false, bannerBlur: bannerBlur !== false } : {}) }, peerId);
  }
  async receive(packet: unknown, peerId: string) {
    if (this.closed || !this.authorized(peerId) || !packet || typeof packet !== 'object') return;
    const p = packet as Record<string, unknown>;
    if (p.kind === 'offer') {
      if (this.images.banner && (typeof p.bannerEnabled !== 'boolean' || typeof p.bannerBlur !== 'boolean')) return;
      if (!validProfileColor(p.color) || (p.cardColor !== undefined && !validProfileColor(p.cardColor)) || !(p.hash === '' || validProfileHash(p.hash)) ||
        !Number.isInteger(p.size) || (p.size as number) < 0 || (p.size as number) > Math.ceil(PROFILE_MAX_BYTES / 3) * 4 ||
        (p.hash === '') !== (p.size === 0)) return;
      const old = this.offers.get(peerId);
      if (old?.hash === p.hash && old.color === p.color && old.cardColor === (p.cardColor ?? p.color) &&
        old.bannerEnabled === p.bannerEnabled && old.bannerBlur === p.bannerBlur) {
        this.deferred.delete(peerId); this.requestWaiting(); return;
      }
      if (p.hash !== '' && Date.now() - (this.lastOffer.get(peerId) ?? 0) < 1000) {
        this.deferred.set(peerId, { hash: p.hash, size: p.size as number, color: p.color, cardColor: (p.cardColor ?? p.color) as string,
          ...(this.images.banner ? { bannerEnabled: p.bannerEnabled as boolean, bannerBlur: p.bannerBlur as boolean } : {}) }); return;
      }
      this.deferred.delete(peerId);
      this.lastOffer.set(peerId, Date.now());
      const offer = { hash: p.hash, size: p.size as number, color: p.color, cardColor: (p.cardColor ?? p.color) as string,
        ...(this.images.banner ? { bannerEnabled: p.bannerEnabled as boolean, bannerBlur: p.bannerBlur as boolean } : {}) };
      this.offers.set(peerId, offer);
      if (!this.pending.get(peerId)?.validating) this.pending.delete(peerId);
      this.images.announce(peerId, offer.hash, offer.color, offer.cardColor, offer.bannerEnabled, offer.bannerBlur);
      // The first offer also confirms the remote receiver is admitted and ready.
      // An earlier admission-time announcement may have arrived before its gate opened.
      if (!old) void this.announce(peerId).catch(() => {});
      this.requestWaiting();
    } else if (p.kind === 'request') {
      const { hash, data } = this.images.local;
      const lastSend = this.lastSend.get(peerId);
      if (!hash || p.hash !== hash || typeof p.token !== 'string' || !/^[a-f0-9-]{36}$/.test(p.token)) return;
      if (this.sending.has(peerId)) { this.queuedSends.set(peerId, packet); return; }
      if (lastSend?.hash === hash && Date.now() - lastSend.at < 3000) return;
      this.lastSend.set(peerId, { at: Date.now(), hash }); this.sending.add(peerId);
      try {
        for (let offset = 0; offset < data.length; offset += PROFILE_CHUNK) {
          if (this.closed || !this.authorized(peerId) || this.images.local.hash !== hash) break;
          await this.send({ kind: 'chunk', hash, token: p.token, index: offset / PROFILE_CHUNK,
            data: data.slice(offset, offset + PROFILE_CHUNK) }, peerId);
        }
      } finally {
        this.sending.delete(peerId);
        const queued = this.queuedSends.get(peerId); this.queuedSends.delete(peerId);
        if (queued) void this.receive(queued, peerId).catch(() => {});
      }
    } else if (p.kind === 'chunk') {
      const request = this.pending.get(peerId);
      if (!request || request.validating || request.until < Date.now() || p.hash !== request.offer.hash || p.token !== request.token ||
        p.index !== request.parts.length || typeof p.data !== 'string' || p.data.length === 0 ||
        p.data.length !== Math.min(PROFILE_CHUNK, request.offer.size - request.length) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(p.data)) return;
      request.parts.push(p.data); request.length += p.data.length;
      if (request.length === request.offer.size) {
        request.validating = true;
        try { await this.images.accept(request.parts.join(''), request.offer.hash); }
        catch { /* Invalid images never reach the rendered profile. */ }
        finally {
          if (this.pending.get(peerId) === request) this.pending.delete(peerId);
          this.attempts.set(peerId, { hash: request.offer.hash, count: 2 });
          this.requestWaiting();
        }
      }
    }
  }
  forget(peerId: string) {
    this.pending.delete(peerId); this.offers.delete(peerId); this.lastOffer.delete(peerId); this.lastSend.delete(peerId);
    this.attempts.delete(peerId);
    this.deferred.delete(peerId);
    this.queuedSends.delete(peerId);
    this.images.forget(peerId);
  }
  close() {
    this.closed = true; clearInterval(this.timer); this.pending.clear(); this.offers.clear();
    this.deferred.clear(); this.queuedSends.clear(); this.images.clearPeers();
  }
}
