import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export interface VideoFramePayload {
  jpeg_base64: string;
  width: number;
  height: number;
}

export class NativeVideoBridge {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private unlisten: UnlistenFn | null = null;
  private isCapturing = false;
  private latestImage: HTMLImageElement | null = null;
  private animFrameId: number | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1920;
    this.canvas.height = 1080;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
  }

  public async startCapture(
    sourceId: string,
    fps: number,
    resolution: { width: number; height: number }
  ): Promise<MediaStream> {
    this.canvas.width = resolution.width;
    this.canvas.height = resolution.height;

    // Draw initial studio background
    if (this.ctx) {
      this.ctx.fillStyle = '#0a0c10';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    try {
      this.unlisten = await listen<VideoFramePayload>('p2sharer://video-frame', (event) => {
        const payload = event.payload;
        if (!payload || !payload.jpeg_base64) return;

        const img = new Image();
        img.onload = () => {
          this.latestImage = img;
          if (this.ctx) {
            this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
          }
        };
        img.src = `data:image/jpeg;base64,${payload.jpeg_base64}`;
      });

      await invoke('start_native_screen_capture', {
        sourceId,
        targetFps: fps,
        targetWidth: resolution.width,
        targetHeight: resolution.height,
      });

      this.isCapturing = true;

      // Active paint loop to ensure canvas.captureStream always has active frames
      const renderLoop = () => {
        if (!this.isCapturing) return;
        if (this.latestImage && this.ctx) {
          this.ctx.drawImage(this.latestImage, 0, 0, this.canvas.width, this.canvas.height);
        }
        this.animFrameId = requestAnimationFrame(renderLoop);
      };
      this.animFrameId = requestAnimationFrame(renderLoop);
    } catch (err) {
      console.warn('Native screen capture failed, falling back to display media:', err);
      return await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: fps, width: resolution.width, height: resolution.height },
        audio: false,
      });
    }

    const stream = this.canvas.captureStream(fps);
    return stream;
  }

  public stop(): void {
    if (!this.isCapturing) return;
    this.isCapturing = false;

    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }

    this.latestImage = null;
    invoke('stop_native_screen_capture').catch(() => {});
  }
}
