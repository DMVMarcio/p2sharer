import { invoke } from '@tauri-apps/api/core';
import type { ScreenSourcesResponse, VideoCaptureBridge, VideoSourceOptions } from '../core/types.ts';

export class NativeVideoBridge implements VideoCaptureBridge {
  private activeStream: MediaStream | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private bitmapCtx: ImageBitmapRenderingContext | null = null;
  private ws: WebSocket | null = null;
  private isCapturing: boolean = false;
  private isDirectGpu: boolean = false;
  private latestBitmap: ImageBitmap | null = null;
  private animationFrameId: number | null = null;
  private currentFps: number = 60;
  public onFallbackNeeded: ((reason: string, stream?: MediaStream) => void) | null = null;

  public isCapturingDirectGpu(): boolean {
    return this.isCapturing && this.isDirectGpu;
  }

  public isCapturingNative(): boolean {
    return this.isCapturing && !this.isDirectGpu;
  }

  /**
   * Captures screen directly via Chromium/WebView2 GPU pipeline (Zero CPU copy / HW NVENC/QSV/VCN)
   */
  public async startDisplayMediaCapture(
    frameRate: number = 60,
    resolution?: { width: number; height: number },
    cursor: boolean = true,
    preferSurface?: 'monitor' | 'window'
  ): Promise<MediaStream> {
    await this.stopCapture();
    this.isCapturing = true;
    this.isDirectGpu = true;
    this.currentFps = frameRate;

    try {
      const videoConstraints: MediaTrackConstraints = {
        frameRate: { ideal: frameRate, max: 120 },
      };

      if (resolution && resolution.width > 0 && resolution.height > 0) {
        videoConstraints.width = { ideal: resolution.width, max: resolution.width };
        videoConstraints.height = { ideal: resolution.height, max: resolution.height };
      }

      if (preferSurface) {
        // Hint to Chromium whether we prefer monitor or window picker tab
        (videoConstraints as Record<string, unknown>).displaySurface = preferSurface;
      }

      if (!cursor) {
        (videoConstraints as Record<string, unknown>).cursor = 'never';
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: false,
      });

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        if ('contentHint' in videoTrack) {
          videoTrack.contentHint = 'motion';
        }
        videoTrack.onended = () => {
          this.stopCapture();
        };
      }

      this.activeStream = stream;
      return stream;
    } catch (err) {
      this.isCapturing = false;
      this.isDirectGpu = false;
      throw err;
    }
  }

  public async startCapture(
    optionsOrSourceId: VideoSourceOptions | string,
    fps: number = 60,
    resolution: { width: number; height: number } = { width: 1920, height: 1080 },
    captureMouse: boolean = true,
    quality: number = 75
  ): Promise<MediaStream> {
    if (typeof optionsOrSourceId === 'object' && optionsOrSourceId !== null) {
      const opts = optionsOrSourceId as VideoSourceOptions;
      if (opts.mode === 'gpu_direct') {
        return this.startDisplayMediaCapture(opts.frameRate || fps, resolution, captureMouse, 'monitor');
      }
      const sId = opts.sourceId || 'screen:0';
      return this.startNativeCapture(sId, opts.frameRate || fps, resolution, captureMouse, quality);
    }

    const sId = (optionsOrSourceId as string) || 'screen:0';
    const effectiveSourceId =
      sId === 'gpu_direct' || sId === 'direct_gpu' || sId === 'screen:direct_gpu' ? 'screen:0' : sId;

    // In-app selected screen or window: capture directly via native GPU capture without Chromium prompt!
    return this.startNativeCapture(effectiveSourceId, fps, resolution, captureMouse, quality);
  }

  private async startNativeCapture(
    sourceId: string,
    fps: number,
    resolution: { width: number; height: number },
    captureMouse: boolean,
    quality: number
  ): Promise<MediaStream> {
    await this.stopCapture();
    this.currentFps = fps;

    // 1. Create high performance offscreen canvas
    this.canvas = document.createElement('canvas');
    this.canvas.width = resolution.width;
    this.canvas.height = resolution.height;

    try {
      this.bitmapCtx = this.canvas.getContext('bitmaprenderer') as ImageBitmapRenderingContext | null;
    } catch {
      this.bitmapCtx = null;
    }

    if (!this.bitmapCtx) {
      this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
      if (this.ctx) {
        this.ctx.imageSmoothingEnabled = false;
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, resolution.width, resolution.height);
      }
    }

    this.isCapturing = true;
    this.isDirectGpu = true;

    // 2. Start native Rust capture thread
    try {
      await invoke('start_native_screen_capture', {
        sourceId,
        targetFps: fps,
        targetWidth: resolution.width,
        targetHeight: resolution.height,
        captureMouse,
        quality,
      });
    } catch (err) {
      this.isCapturing = false;
      this.isDirectGpu = false;
      const reason = err instanceof Error ? err.message : String(err);
      console.error('[NativeVideoBridge] Native Direct GPU capture failed to start:', reason);
      throw new Error(`Falha ao iniciar captura GPU da tela ou janela: ${reason}`);
    }

    // 3. Connect to local binary WebSocket stream
    const port = (await invoke<number>('get_video_ws_port').catch(() => 49153)) || 49153;
    let sequenceCounter = 0;
    let lastRenderedSequence = 0;
    let isProcessingFrame = false;

    await new Promise<void>((resolve) => {
      let resolved = false;
      const wsUrl = `ws://127.0.0.1:${port}`;
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      this.ws.onmessage = async (evt: MessageEvent) => {
        if (!this.isCapturing) return;

        // Handle error signaling from native backend (window minimized, DRM, capture error)
        if (typeof evt.data === 'string') {
          let reason = 'capture_error';
          try {
            const parsed = JSON.parse(evt.data);
            reason = parsed.reason || parsed.type || 'capture_error';
          } catch {
            reason = evt.data;
          }
          console.warn('[NativeVideoBridge] Received capture signal from native backend:', reason);
          if (this.onFallbackNeeded) {
            this.onFallbackNeeded(reason);
          }
          return;
        }

        if (evt.data instanceof ArrayBuffer) {
          const frameSeq = ++sequenceCounter;

          if (isProcessingFrame && frameSeq - lastRenderedSequence > 1) {
            return;
          }

          isProcessingFrame = true;
          try {
            const blob = new Blob([evt.data], { type: 'image/jpeg' });
            const bitmap = await createImageBitmap(blob);

            if (frameSeq < lastRenderedSequence || !this.isCapturing) {
              bitmap.close();
              isProcessingFrame = false;
              return;
            }

            lastRenderedSequence = frameSeq;
            if (this.bitmapCtx) {
              this.bitmapCtx.transferFromImageBitmap(bitmap);
            } else if (this.ctx && this.canvas) {
              this.ctx.drawImage(bitmap, 0, 0, this.canvas.width, this.canvas.height);
              bitmap.close();
            } else {
              bitmap.close();
            }

            const track = this.activeStream?.getVideoTracks()[0];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (track && typeof (track as any).requestFrame === 'function') {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (track as any).requestFrame();
            }
          } catch {
            // Ignore frame decode failure
          } finally {
            isProcessingFrame = false;
          }
        }
      };

      this.ws.onerror = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, 500);
    });

    const stream = this.canvas.captureStream(fps);
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      if ('contentHint' in videoTrack) {
        videoTrack.contentHint = 'motion';
      }
    }

    this.activeStream = stream;
    return stream;
  }

  public async triggerFallback(reason: string, fps: number): Promise<void> {
    if (this.isDirectGpu) return;
    try {
      const fallbackStream = await this.startDisplayMediaCapture(fps);
      if (this.onFallbackNeeded) {
        this.onFallbackNeeded(reason, fallbackStream);
      }
    } catch (err) {
      console.warn('[NativeVideoBridge] Direct GPU fallback was cancelled or failed:', err);
    }
  }

  public getActiveStream(): MediaStream | null {
    return this.activeStream;
  }

  public async listSources(): Promise<Array<{ id: string; name: string; thumbnail?: string }>> {
    try {
      const resp = await invoke<ScreenSourcesResponse>('list_screen_sources');
      const list: Array<{ id: string; name: string; thumbnail?: string }> = [];
      if (resp.monitors) {
        resp.monitors.forEach((m) => {
          list.push({ id: m.id, name: m.name, thumbnail: m.thumbnail });
        });
      }
      if (resp.windows) {
        resp.windows.forEach((w) => {
          list.push({ id: w.id, name: w.title || w.process_name, thumbnail: w.thumbnail });
        });
      }
      return list;
    } catch {
      return [];
    }
  }

  public getCurrentFps(): number {
    return this.currentFps;
  }

  public async stop(): Promise<void> {
    await this.stopCapture();
  }

  public async stopCapture(): Promise<void> {
    this.isCapturing = false;
    this.isDirectGpu = false;
    await invoke('stop_native_screen_capture').catch(() => {});

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.latestBitmap) {
      this.latestBitmap.close();
      this.latestBitmap = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.activeStream) {
      this.activeStream.getTracks().forEach((t) => t.stop());
      this.activeStream = null;
    }

    this.canvas = null;
    this.ctx = null;
    this.bitmapCtx = null;
  }
}
