import { invoke } from '@tauri-apps/api/core';
import { automaticCardColor } from './profile_card_color.ts';
import { hsvToHex } from './hsv_color.ts';

export interface ProfileImage { hash: string; data: string; color: string; cardColor?: string | null; dominantColor?: string | null; bannerEnabled?: boolean; bannerBlur?: boolean }
export interface ImageCrop { x: number; y: number; size: number }
export interface ProfileDraft { token: string; preview: string; width: number; height: number; crop: ImageCrop }
export const PROFILE_MAX_BYTES = 8 * 1024 * 1024;
export const PROFILE_CHUNK = 32 * 1024; // Base64 characters, divisible by four.
export const BANNER_ASPECT = 3;
export const validProfileHash = (hash: unknown): hash is string => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
export const validProfileColor = (color: unknown): color is string => typeof color === 'string' && /^#[a-f0-9]{6}$/i.test(color);

// Remote images and hashes live only for the current application process.
class ProfileImages {
  readonly banner: boolean;
  constructor(banner = false) { this.banner = banner; this.ready = this.load(); }
  local: ProfileImage = { hash: '', data: '',
    color: automaticCardColor(hsvToHex({ h: Math.random() * 360, s: 0.65, v: 0.8 })) };
  peers = new Map<string, { hash: string; color: string; cardColor: string; bannerEnabled?: boolean; bannerBlur?: boolean }>();
  private cache = new Map<string, string>();
  private listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.revision;
  private notify() { this.revision++; this.listeners.forEach(fn => fn()); }
  readonly ready: Promise<void>;
  private async load() {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    try {
      const local = await invoke<ProfileImage | null>('load_profile_image', this.banner ? { banner: true } : undefined);
      this.local = local ?? (this.banner ? this.local : await invoke<ProfileImage>('save_profile_image', {
        token: null, crop: null, color: this.local.color, cardColor: null, remove: false,
      }));
      this.notify();
    } catch (error) { console.warn('[Profile] Saved image could not be loaded:', error); }
  }
  async save(draft: ProfileDraft | null, color: string, remove: boolean, cardColor: string | null = null, bannerEnabled = true, bannerBlur = true) {
    await this.ready;
    this.local = await invoke<ProfileImage>('save_profile_image', { token: draft?.token ?? null, crop: draft?.crop ?? null, color, cardColor, remove,
      ...(this.banner ? { banner: true, bannerEnabled, bannerBlur } : {}) });
    this.notify();
    // Settings owns both drafts until close, including retries after another save fails.
  }
  url(peerId: string, local = false) {
    if (local || peerId === 'local') return this.local.data ? `data:image/png;base64,${this.local.data}` : undefined;
    return this.cache.get(this.peers.get(peerId)?.hash ?? '');
  }
  color(peerId: string, local = false) { return local || peerId === 'local' ? this.local.color : this.peers.get(peerId)?.color; }
  background(peerId: string, local = false, fallback?: string) {
    return local || peerId === 'local' ? this.local.cardColor ?? automaticCardColor(this.local.dominantColor ?? this.local.color)
      : this.peers.get(peerId)?.cardColor ?? automaticCardColor(fallback ?? '#06b6d4');
  }
  cardBanner(peerId: string, local = false) {
    const profile = local || peerId === 'local' ? this.local : this.peers.get(peerId);
    return profile?.bannerEnabled === false ? undefined : this.url(peerId, local);
  }
  blur(peerId: string, local = false) {
    return (local || peerId === 'local' ? this.local : this.peers.get(peerId))?.bannerBlur !== false;
  }
  has(hash: string) { return this.cache.has(hash) || hash === this.local.hash; }
  announce(peerId: string, hash: string, color: string, cardColor = color, bannerEnabled = true, bannerBlur = true) {
    this.peers.set(peerId, { hash, color, cardColor, ...(this.banner ? { bannerEnabled, bannerBlur } : {}) });
    if (hash && hash === this.local.hash) this.cacheUrl(hash, `data:image/png;base64,${this.local.data}`);
    this.notify();
  }
  async accept(data: string, hash: string) {
    const url = await invoke<string>('validate_profile_image', { data, hash, ...(this.banner ? { banner: true } : {}) });
    this.cacheUrl(hash, url); this.notify();
  }
  private cacheUrl(hash: string, url: string) {
    // Bound the process cache (including data URL overhead) and retain recent hashes.
    this.cache.delete(hash);
    while (this.cache.size && [...this.cache.values()].reduce((n, url) => n + url.length, 0) + url.length > 64 * 1024 * 1024) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(hash, url);
  }
  forget(peerId: string) { this.peers.delete(peerId); this.notify(); }
  clearPeers() { this.peers.clear(); this.notify(); }
}
export const profileImages = new ProfileImages();
export const profileBanners = new ProfileImages(true);
