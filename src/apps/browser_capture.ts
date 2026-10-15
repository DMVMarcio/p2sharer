import { invoke } from '@tauri-apps/api/core';
import { NativeVideoBridge } from '../video/native_video_bridge.ts';
import type { BrowserState } from './browser_protocol.ts';
import type { BrowserQualityController } from './browser_quality.ts';

interface CaptureBridge {
  startCapture(source: string, fps: number, size: { width: number; height: number }, cursor: boolean, quality: number): Promise<MediaStream>;
  updateProfile(fps: number, width: number, height: number): Promise<void>;
  getProcessingCost(): number;
  stopCapture(): Promise<void>;
}
export interface BrowserCaptureDependencies {
  call<T>(command: string, args: Record<string, unknown>): Promise<T>;
  bridge(session: string): CaptureBridge;
}
const dependencies: BrowserCaptureDependencies = { call: invoke, bridge: session => new NativeVideoBridge(session) };

/** Pixels use the native binary media bridge; only bounded metadata uses IPC. */
export class BrowserCapture {
  readonly sessionId: string;
  private bridge: CaptureBridge;
  private stopped = true;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private source = '';
  private profile = '';
  private refreshing = false;
  private refreshAgain = false;
  private previous: { images: number; processing_us: number } | null = null;
  private scope: string;
  private quality: BrowserQualityController;
  private stream: (stream: MediaStream, tab: number) => void;
  private metadata: (state: BrowserState) => void;
  private changed: () => void;
  private failed: (error: unknown) => void;
  private native: BrowserCaptureDependencies;
  constructor(scope: string, quality: BrowserQualityController,
    stream: (stream: MediaStream, tab: number) => void, metadata: (state: BrowserState) => void,
    changed: () => void, failed: (error: unknown) => void,
    native = dependencies) {
    this.scope = scope; this.quality = quality; this.stream = stream; this.metadata = metadata;
    this.changed = changed; this.failed = failed; this.native = native;
    // Retired generations cannot stop another session that reuses the room app scope.
    this.sessionId = `browser-${scope}-${crypto.randomUUID()}`;
    this.bridge = native.bridge(this.sessionId);
  }
  async start(): Promise<void> {
    this.stopped = false; this.generation++;
    await this.refresh();
  }
  requestRefresh(): void {
    if (this.stopped) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    clearTimeout(this.timer); void this.refresh().catch(this.failed);
  }
  private async refresh(): Promise<void> {
    if (this.stopped || this.refreshing) return;
    this.refreshing = true; const generation = this.generation; let successful = false;
    try {
      const quality = this.quality.quality;
      const frame = await this.native.call<{ sourceId: string | null; state: BrowserState; playing: boolean | null }>('prepare_shared_browser_capture',
        { scope: this.scope, width: quality.width, probe: true, sessionId: this.sessionId });
      if (this.stopped || generation !== this.generation) return;
      if (frame.sourceId === null) {
        this.metadata(frame.state); this.refreshAgain = true; successful = true; return;
      }
      const profile = JSON.stringify(quality);
      if (frame.sourceId !== this.source) {
        const stream = await this.bridge.startCapture(frame.sourceId, quality.fps, quality, false, 90);
        if (this.stopped || generation !== this.generation) { await this.bridge.stopCapture(); return; }
        this.source = frame.sourceId; this.previous = null; this.stream(stream, frame.state.active);
        this.profile = profile;
      } else if (profile !== this.profile) {
        await this.bridge.updateProfile(quality.fps, quality.width, quality.height);
        if (this.stopped || generation !== this.generation) return;
        this.profile = profile;
      }
      if (typeof frame.playing === 'boolean') this.quality.detect(frame.playing, performance.now());
      this.metadata(frame.state);
      const metrics = await this.native.call<{ images: number; processing_us: number }>('get_capture_metrics', { sessionId: this.sessionId });
      if (this.stopped || generation !== this.generation) return;
      if (this.previous && metrics.images - this.previous.images >= 3) {
        this.quality.sample((metrics.processing_us - this.previous.processing_us) / (metrics.images - this.previous.images) / 1000
          + this.bridge.getProcessingCost(), performance.now());
      }
      this.previous = metrics;
      if (JSON.stringify(this.quality.quality) !== profile) this.changed();
      successful = true;
    } finally {
      this.refreshing = false;
      if (!this.stopped && generation === this.generation) {
        const soon = successful && (this.refreshAgain || JSON.stringify(this.quality.quality) !== this.profile);
        this.refreshAgain = false;
        this.timer = setTimeout(() => void this.refresh().catch(this.failed), soon ? 0 : 1000);
      }
    }
  }
  stop(): void {
    this.stopped = true; this.generation++; clearTimeout(this.timer);
    void this.bridge.stopCapture().catch(() => {});
  }
}
