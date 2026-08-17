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
  private latestBitmap: ImageBitmap | null = null;
  private animFrameId: number | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1920;
    this.canvas.height = 1080;
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
  }

  public async startCapture(
    sourceId: string,
    fps: number,
    resolution: { width: number; height: number },
    captureMouse: boolean = true,
    quality: number = 92
  ): Promise<MediaStream> {
    this.canvas.width = resolution.width;
    this.canvas.height = resolution.height;

    // Draw initial studio background
    if (this.ctx) {
      this.ctx.fillStyle = '#0a0c10';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    try {
      this.unlisten = await listen<VideoFramePayload>('p2sharer://video-frame', async (event) => {
        const payload = event.payload;
        if (!payload || !payload.jpeg_base64) return;

        try {
          const binary = atob(payload.jpeg_base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: 'image/jpeg' });
          const bitmap = await createImageBitmap(blob);
          if (this.latestBitmap) {
            this.latestBitmap.close();
          }
          this.latestBitmap = bitmap;
          if (this.ctx) {
            this.ctx.drawImage(bitmap, 0, 0, this.canvas.width, this.canvas.height);
          }
        } catch {
          // Ignore transient decode errors
        }
      });

      await invoke('start_native_screen_capture', {
        sourceId,
        targetFps: fps,
        targetWidth: resolution.width,
        targetHeight: resolution.height,
        captureMouse,
        quality,
      });

      this.isCapturing = true;

      // Active paint loop to ensure canvas.captureStream always has active frames
      const renderLoop = () => {
        if (!this.isCapturing) return;
        if (this.latestBitmap && this.ctx) {
          this.ctx.drawImage(this.latestBitmap, 0, 0, this.canvas.width, this.canvas.height);
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

    if (this.latestBitmap) {
      this.latestBitmap.close();
      this.latestBitmap = null;
    }

    invoke('stop_native_screen_capture').catch(() => {});
  }
}
