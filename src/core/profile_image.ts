import { invoke } from '../platform/commands.ts';
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
  private peerCache = new Map<string, { hash: string; color: string; cardColor: string; bannerEnabled?: boolean; bannerBlur?: boolean }>();
  private cache = new Map<string, string>();
  private cacheSizes = new Map<string, number>();
  private listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.revision;
  private notify() { this.revision++; this.listeners.forEach(fn => fn()); }
  readonly ready: Promise<void>;
  private async load() {
    if (typeof window === 'undefined' || (!('__TAURI_INTERNALS__' in window) && typeof indexedDB === 'undefined')) return;
    try {
      const local = await invoke<ProfileImage | null>('load_profile_image', this.banner ? { banner: true } : undefined);
      this.local = local ?? (this.banner ? this.local : await invoke<ProfileImage>('save_profile_image', {
        token: null, crop: null, color: this.local.color, cardColor: null, remove: false,
      }));
      this.notify();
    } catch (error) { console.warn('[Profile] Saved image could not be loaded:', error); }
  }
  async save(draft: ProfileDraft | null, color: string, remove: boolean, cardColor: string | null = null, bannerEnabled = true, bannerBlur = false) {
    await this.ready;
    this.local = await invoke<ProfileImage>('save_profile_image', { token: draft?.token ?? null, crop: draft?.crop ?? null, color, cardColor, remove,
      ...(this.banner ? { banner: true, bannerEnabled, bannerBlur } : {}) });
    this.notify();
    // Settings owns both drafts until close, including retries after another save fails.
  }
  url(peerId: string, local = false) {
    if (local || peerId === 'local') return this.local.data ? `data:image/png;base64,${this.local.data}` : undefined;
    const entry = this.peers.get(peerId) ?? this.peerCache.get(peerId);
    return this.cache.get(entry?.hash ?? '');
  }
  color(peerId: string, local = false) {
    return local || peerId === 'local' ? this.local.color : (this.peers.get(peerId) ?? this.peerCache.get(peerId))?.color;
  }
  background(peerId: string, local = false, fallback?: string) {
    const entry = this.peers.get(peerId) ?? this.peerCache.get(peerId);
    return local || peerId === 'local' ? this.local.cardColor ?? automaticCardColor(this.local.dominantColor ?? this.local.color)
      : entry?.cardColor ?? automaticCardColor(fallback ?? '#06b6d4');
  }
  cardBanner(peerId: string, local = false) {
    if (!local && peerId !== 'local' && !this.peers.has(peerId)) return undefined;
    const profile = local || peerId === 'local' ? this.local : this.peers.get(peerId);
    return profile?.bannerEnabled === false ? undefined : this.url(peerId, local);
  }
  blur(peerId: string, local = false) {
    return (local || peerId === 'local' ? this.local : (this.peers.get(peerId) ?? this.peerCache.get(peerId)))?.bannerBlur === true;
  }
  has(hash: string) { return this.cache.has(hash) || hash === this.local.hash; }
  announce(peerId: string, hash: string, color: string, cardColor = color, bannerEnabled = true, bannerBlur = false) {
    const entry = { hash, color, cardColor, ...(this.banner ? { bannerEnabled, bannerBlur } : {}) };
    this.peers.set(peerId, entry);
    this.peerCache.set(peerId, entry);
    if (hash && hash === this.local.hash) this.cacheUrl(hash, `data:image/png;base64,${this.local.data}`);
    this.notify();
  }
  async accept(data: string, hash: string) {
    const url = await invoke<string>('validate_profile_image', { data, hash, ...(this.banner ? { banner: true } : {}) });
    this.cacheUrl(hash, url); this.notify();
  }
  async acceptBytes(data: Uint8Array, hash: string) {
    await invoke('validate_profile_image_bytes', data, { headers: {
      'x-profile-hash': hash, 'x-profile-banner': this.banner ? 'true' : 'false',
    } });
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'image/png' }));
    this.cacheUrl(hash, url, data.length); this.notify();
  }
  private evict(hash: string) {
    const url = this.cache.get(hash);
    if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    this.cache.delete(hash); this.cacheSizes.delete(hash);
  }
  private cacheUrl(hash: string, url: string, bytes = url.length) {
    // Bound the process cache (including data URL overhead) and retain recent hashes.
    this.evict(hash);
    while (this.cache.size && [...this.cacheSizes.values()].reduce((n, size) => n + size, 0) + bytes > 64 * 1024 * 1024) {
      this.evict(this.cache.keys().next().value!);
    }
    this.cache.set(hash, url);
    this.cacheSizes.set(hash, bytes);
  }
  forget(peerId: string) { this.peers.delete(peerId); this.notify(); }
  clearPeers() { this.peers.clear(); this.peerCache.clear(); this.notify(); }
}
export const profileImages = new ProfileImages();
export const profileBanners = new ProfileImages(true);
