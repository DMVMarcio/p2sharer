import { invoke } from '@tauri-apps/api/core';

export class NativeVideoBridge {
  private activeStream: MediaStream | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private ws: WebSocket | null = null;
  private isCapturing: boolean = false;
  private latestBitmap: ImageBitmap | null = null;
  private animationFrameId: number | null = null;

  public async startCapture(
    sourceId: string,
    fps: number,
    resolution: { width: number; height: number },
    captureMouse: boolean = true,
    quality: number = 70
  ): Promise<MediaStream> {
    this.stop();

    // 1. Create high performance offscreen canvas
    this.canvas = document.createElement('canvas');
    this.canvas.width = resolution.width;
    this.canvas.height = resolution.height;
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });

    if (this.ctx) {
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.fillStyle = '#000000';
      this.ctx.fillRect(0, 0, resolution.width, resolution.height);
    }

    this.isCapturing = true;

    // 2. Start native Rust capture thread (Parallel 4-Thread Pool)
    await invoke('start_native_screen_capture', {
      sourceId,
      targetFps: fps,
      targetWidth: resolution.width,
      targetHeight: resolution.height,
      captureMouse,
      quality,
    });

    // 3. Connect to local binary WebSocket stream (Dedicated dynamic port per instance)
    const port = (await invoke<number>('get_video_ws_port').catch(() => 49153)) || 49153;
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

        if (evt.data instanceof ArrayBuffer) {
          try {
            const blob = new Blob([evt.data], { type: 'image/jpeg' });
            const bitmap = await createImageBitmap(blob);
            if (this.latestBitmap) {
              this.latestBitmap.close();
            }
            this.latestBitmap = bitmap;

            if (this.ctx && this.canvas && this.latestBitmap) {
              this.ctx.drawImage(this.latestBitmap, 0, 0, this.canvas.width, this.canvas.height);
            }
          } catch {}
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
  }
}
