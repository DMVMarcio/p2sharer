export type BrowserVideoQuality = '720p30' | '1080p30' | '1080p60';
export type BrowserContentMode = 'auto' | 'reading' | 'video';
export interface BrowserQualitySettings { mode: BrowserContentMode; video: BrowserVideoQuality; bitrate?: 'balanced' | 'high' }
export interface BrowserCaptureQuality { width: number; height: number; fps: number; video: boolean }
const levels = [
  { width: 1280, height: 720, fps: 30 },
  { width: 1920, height: 1080, fps: 30 },
  { width: 1920, height: 1080, fps: 60 },
];
export function validBrowserQuality(value: unknown): value is BrowserQualitySettings {
  if (!value || typeof value !== 'object') return false;
  const settings = value as BrowserQualitySettings;
  return ['auto', 'reading', 'video'].includes(settings.mode) && ['720p30', '1080p30', '1080p60'].includes(settings.video)
    && (settings.bitrate === undefined || ['balanced', 'high'].includes(settings.bitrate));
}
export function browserVideoBitrate(quality: BrowserCaptureQuality, setting: BrowserQualitySettings['bitrate']): number {
  if (!quality.video) return 3_000_000;
  if (setting === 'balanced') return quality.width === 1920 ? (quality.fps === 60 ? 9_000_000 : 6_000_000) : 4_000_000;
  return quality.width === 1920 ? (quality.fps === 60 ? 20_000_000 : 12_000_000) : 8_000_000;
}
export function loadBrowserQuality(): BrowserQualitySettings {
  try { const saved: unknown = JSON.parse(localStorage.getItem('browser-quality-v1') ?? 'null'); if (validBrowserQuality(saved)) return saved; } catch {}
  return { mode: 'auto', video: '1080p30' };
}

/** Capture headroom, rather than CPU model names, controls upgrades. Never queue frames. */
export class BrowserQualityController {
  settings: BrowserQualitySettings;
  private videoSeen = -Infinity;
  private detected = false;
  private level = 0;
  private goodSince: number | null = null;
  private badSince: number | null = null;
  private lastChange = -Infinity;
  private average: number | null = null;
  constructor(settings: BrowserQualitySettings) { this.settings = { ...settings }; }
  configure(settings: BrowserQualitySettings): void {
    this.settings = { ...settings }; this.level = 0; this.goodSince = this.badSince = null;
    this.average = null;
  }
  reset(): void {
    this.configure(this.settings); this.videoSeen = -Infinity; this.detected = false; this.lastChange = -Infinity;
  }
  detect(playing: boolean, now: number): void {
    if (playing) this.videoSeen = now;
    this.detected = playing || now - this.videoSeen < 3000;
  }
  get quality(): BrowserCaptureQuality {
    const video = this.settings.mode === 'video' || this.settings.mode === 'auto' && this.detected;
    if (!video) return { width: 1280, height: 720, fps: 15, video: false };
    const ceiling = ['720p30', '1080p30', '1080p60'].indexOf(this.settings.video);
    return { ...levels[Math.min(this.level, ceiling)], video: true };
  }
  sample(duration: number, now: number): void {
    if (!Number.isFinite(duration) || duration < 0) return;
    const quality = this.quality;
    if (!quality.video) { this.level = 0; this.goodSince = this.badSince = null; this.average = null; return; }
    this.average = this.average === null ? duration : this.average * 0.9 + duration * 0.1;
    const ceiling = ['720p30', '1080p30', '1080p60'].indexOf(this.settings.video);
    const budget = 1000 / quality.fps;
    // A 1080p upgrade adds 2.25x pixels; 60 fps halves the frame budget.
    const headroom = this.average < budget * (this.level === 0 ? 0.3 : 0.35);
    this.goodSince = headroom ? this.goodSince ?? now : null;
    this.badSince = this.average > budget * 0.9 ? this.badSince ?? now : null;
    if (this.badSince !== null && now - this.badSince >= 2000 && this.level > 0) {
      this.level--; this.lastChange = now; this.goodSince = this.badSince = null; this.average = null;
    } else if (this.goodSince !== null && now - this.goodSince >= 8000 && now - this.lastChange >= 15000 && this.level < ceiling) {
      this.level++; this.lastChange = now; this.goodSince = this.badSince = null; this.average = null;
    }
  }
}
