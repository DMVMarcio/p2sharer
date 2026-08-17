import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

interface VideoFramePayload {
  jpeg_base64: string;
  width: u32;
  height: u32;
}

type u32 = number;

export class NativeVideoBridge {
  private activeStream: MediaStream | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private unlistenFn: UnlistenFn | null = null;
  private renderImage: HTMLImageElement = new Image();
  private isCapturing: boolean = false;

  public async startCapture(
    sourceId: string,
    fps: number,
    resolution: { width: number; height: number },
    captureMouse: boolean = true,
    quality: number = 88
  ): Promise<MediaStream> {
    this.stop();

    // 1. Create high performance offscreen canvas
    this.canvas = document.createElement('canvas');
    this.canvas.width = resolution.width;
    this.canvas.height = resolution.height;
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });

    if (this.ctx) {
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'medium';
      this.ctx.fillStyle = '#000000';
      this.ctx.fillRect(0, 0, resolution.width, resolution.height);
    }

    this.isCapturing = true;

    // 2. Listen to native Rust screen capture frames (ZERO BROWSER POPUPS!)
    this.unlistenFn = await listen<VideoFramePayload>('p2sharer://video-frame', (event) => {
      if (!this.isCapturing || !this.ctx || !this.canvas) return;

      const payload = event.payload;
      if (!payload || !payload.jpeg_base64) return;

      this.renderImage.onload = () => {
        if (!this.isCapturing || !this.ctx || !this.canvas) return;
        this.ctx.drawImage(this.renderImage, 0, 0, this.canvas.width, this.canvas.height);
      };
      this.renderImage.src = `data:image/jpeg;base64,${payload.jpeg_base64}`;
    });

    // 3. Start native background Rust thread capturing the exact screen/window
    await invoke('start_native_screen_capture', {
      sourceId,
      targetFps: fps,
      targetWidth: resolution.width,
      targetHeight: resolution.height,
      captureMouse,
      quality,
    });

    // 4. Capture native WebRTC MediaStream from canvas at exact target FPS
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

  public stop(): void {
    this.isCapturing = false;
    invoke('stop_native_screen_capture').catch(() => {});

    if (this.unlistenFn) {
      this.unlistenFn();
      this.unlistenFn = null;
    }

    if (this.activeStream) {
      this.activeStream.getTracks().forEach((t) => t.stop());
      this.activeStream = null;
    }

    this.canvas = null;
    this.ctx = null;
  }
}
