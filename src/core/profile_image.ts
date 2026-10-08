import { invoke } from '@tauri-apps/api/core';
import { automaticCardColor } from './profile_card_color.ts';

export interface ProfileImage { hash: string; data: string; color: string; cardColor?: string | null; dominantColor?: string | null }
export interface ImageCrop { x: number; y: number; size: number }
export interface ProfileDraft { token: string; preview: string; width: number; height: number; crop: ImageCrop }
export const PROFILE_MAX_BYTES = 8 * 1024 * 1024;
export const PROFILE_CHUNK = 32 * 1024; // Base64 characters, divisible by four.
export const validProfileHash = (hash: unknown): hash is string => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
export const validProfileColor = (color: unknown): color is string => typeof color === 'string' && /^#[a-f0-9]{6}$/i.test(color);

// Remote images and hashes live only for the current application process.
class ProfileImages {
  local: ProfileImage = { hash: '', data: '', color: '#06b6d4' };
  peers = new Map<string, { hash: string; color: string; cardColor: string }>();
  private cache = new Map<string, string>();
  private listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.revision;
  private notify() { this.revision++; this.listeners.forEach(fn => fn()); }
  readonly ready = this.load();
  private async load() {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    try {
      const local = await invoke<ProfileImage | null>('load_profile_image');
      if (local) { this.local = local; this.notify(); }
    } catch (error) { console.warn('[Profile] Saved image could not be loaded:', error); }
  }
  async save(draft: ProfileDraft | null, color: string, remove: boolean, cardColor: string | null = null) {
    await this.ready;
    this.local = await invoke<ProfileImage>('save_profile_image', { token: draft?.token ?? null, crop: draft?.crop ?? null, color, cardColor, remove });
    this.notify();
    void invoke('discard_profile_image').catch(() => {});
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
  has(hash: string) { return this.cache.has(hash) || hash === this.local.hash; }
  announce(peerId: string, hash: string, color: string, cardColor = color) {
    this.peers.set(peerId, { hash, color, cardColor });
    if (hash && hash === this.local.hash) this.cacheUrl(hash, `data:image/png;base64,${this.local.data}`);
    this.notify();
  }
  async accept(data: string, hash: string) {
    const url = await invoke<string>('validate_profile_image', { data, hash });
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
