import { invoke } from '@tauri-apps/api/core';
import type { ScreenSourcesResponse, VideoCaptureBridge, VideoSourceOptions } from '../core/types.ts';
import { BridgeLoadMeter } from './bridge_load_meter.ts';
import { VideoFrameClock } from './frame_timing.ts';
import { isNativeEncodedPacket, NativeEncodedDecoder } from './native_encoded_video.ts';

export class NativeVideoBridge implements VideoCaptureBridge {
  public readonly sessionId: string;
  constructor(sessionId = 'default') { this.sessionId = sessionId; }
  private activeStream: MediaStream | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private ws: WebSocket | null = null;
  private isCapturing: boolean = false;
  private isDirectGpu: boolean = false;
  private latestBitmap: ImageBitmap | null = null;
  private encodedDecoder: NativeEncodedDecoder | null = null;
  private latestEncodedFrame: VideoFrame | null = null;
  private animationFrameId: number | null = null;
  private currentFps: number = 60;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private trackGenerator: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private trackWriter: any = null;
  private frameClock = new VideoFrameClock();
  private effectiveFps = 60;
  private pendingBuffer: ArrayBuffer | null = null;
  private isDecoding: boolean = false;
  private captureGeneration = 0;
  private encoderFeedbackToken: string | null = null;
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
          videoTrack.contentHint = 'detail';
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
    quality: number = 90
  ): Promise<MediaStream> {
    if (typeof optionsOrSourceId === 'object' && optionsOrSourceId !== null) {
      const opts = optionsOrSourceId as VideoSourceOptions;
      if (opts.mode === 'gpu_direct') {
        return this.startDisplayMediaCapture(
          opts.frameRate || fps,
          opts.resolution || resolution,
          opts.cursor !== false,
          opts.preferSurface || 'monitor'
        );
      }
      const sId = !opts.sourceId ? 'screen:0' : opts.sourceId;
      return this.startNativeCapture(
        sId,
        opts.frameRate || fps,
        opts.resolution || resolution,
        opts.cursor !== false,
        opts.quality || quality
      );
    }

    const rawId = (optionsOrSourceId as string) || 'screen:0';
    const sId = rawId === 'gpu_direct' || rawId === 'direct_gpu' || rawId === 'screen:direct_gpu' ? 'screen:0' : rawId;

    // Official native in-app capture with hardware WGC
    return this.startNativeCapture(sId, fps, resolution, captureMouse, quality);
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
    this.frameClock.reset();
    this.effectiveFps = Math.min(120, Math.max(15, fps));
    const generation = this.captureGeneration;
    const feedbackToken = crypto.randomUUID();
    this.encoderFeedbackToken = feedbackToken;
    const encodedDecoder = new NativeEncodedDecoder(this.sessionId, feedbackToken);
    this.encodedDecoder = encodedDecoder;
    const loadMeter = new BridgeLoadMeter(fps, performance.now());
    let feedbackPending = false;
    let nativeEncodingFailed = false;
    let receivedNativeEncoding = false;

    // 1. Initialize WebCodecs MediaStreamTrackGenerator if available for zero-copy GPU video pipeline
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const GeneratorClass = (globalThis as any).MediaStreamTrackGenerator;
    if (typeof GeneratorClass === 'function') {
      try {
        this.trackGenerator = new GeneratorClass({ kind: 'video' });
        this.trackWriter = this.trackGenerator.writable.getWriter();
        if ('contentHint' in this.trackGenerator) {
          this.trackGenerator.contentHint = 'detail';
        }
      } catch (err) {
        console.warn('[NativeVideoBridge] MediaStreamTrackGenerator failed, using canvas fallback:', err);
        this.trackGenerator = null;
        this.trackWriter = null;
      }
    }

    // Fallback: Create high performance canvas attached to DOM to prevent Chromium power throttle
    if (!this.trackGenerator) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = resolution.width;
      this.canvas.height = resolution.height;
      this.canvas.style.position = 'fixed';
      this.canvas.style.top = '-99999px';
      this.canvas.style.left = '-99999px';
      this.canvas.style.width = '1px';
      this.canvas.style.height = '1px';
      this.canvas.style.opacity = '0';
      this.canvas.style.pointerEvents = 'none';
      this.canvas.setAttribute('aria-hidden', 'true');
      if (typeof document !== 'undefined' && document.body) {
        document.body.appendChild(this.canvas);
      }

      this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
      if (this.ctx) {
        this.ctx.imageSmoothingEnabled = false;
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, resolution.width, resolution.height);
      }
    }

    this.isCapturing = true;
    this.isDirectGpu = false;

    // 2. Start native Rust capture thread
    try {
      await invoke('start_capture_session', {
        sessionId: this.sessionId,
        sourceId,
        targetFps: fps,
        targetWidth: resolution.width,
        targetHeight: resolution.height,
        captureMouse,
        quality,
        feedbackToken,
      });
    } catch (err) {
      this.isCapturing = false;
      this.isDirectGpu = false;
      const reason = err instanceof Error ? err.message : String(err);
      console.error('[NativeVideoBridge] Native capture failed to start:', reason);
      throw new Error(`Falha ao iniciar transmissão da tela ou janela: ${reason}`);
    }

    // 3. Connect to local binary WebSocket stream
    const port = (await invoke<number>('get_video_ws_port').catch(() => 49153)) || 49153;
    let accessToken: string;
    try {
      accessToken = await invoke<string>('get_video_ws_token');
    } catch {
      await this.stopCapture();
      throw new Error('Não foi possível autenticar a captura de vídeo local.');
    }
    this.pendingBuffer = null;
    this.isDecoding = false;

    const pumpNextFrame = async () => {
      if (generation !== this.captureGeneration || this.isDecoding || !this.pendingBuffer || !this.isCapturing) return;
      this.isDecoding = true;
      const buffer = this.pendingBuffer;
      this.pendingBuffer = null;
      const processingStarted = performance.now();

      try {
        let bitmap: ImageBitmap | VideoFrame | null = this.latestEncodedFrame || this.latestBitmap;

        // If buffer contains a real JPEG payload (> 4 bytes), decode it into an ImageBitmap
        if (buffer.byteLength > 4) {
          this.latestEncodedFrame?.close(); this.latestEncodedFrame = null;
          const blob = new Blob([buffer], { type: 'image/jpeg' });
          const newBitmap = await createImageBitmap(blob, {
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none',
          });

          if (!this.isCapturing || generation !== this.captureGeneration) {
            newBitmap.close();
            return;
          }

          if (this.latestBitmap) {
            this.latestBitmap.close();
          }
          this.latestBitmap = newBitmap;
          bitmap = newBitmap;
        }

        if (!bitmap || !this.isCapturing) {
          this.isDecoding = false;
          return;
        }

        // Direct WebCodecs GPU pathway
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const VideoFrameClass = (globalThis as any).VideoFrame;
        if (this.trackWriter && typeof VideoFrameClass === 'function') {
          try {
            const videoFrame = new VideoFrameClass(bitmap, this.frameClock.next(performance.now(), this.effectiveFps));
            try {
              // Keep only the newest pending JPEG while the encoder consumes this frame.
              // Unawaited writes build an unbounded queue on slower GPU encoders.
              const writer = this.trackWriter;
              await writer.ready;
              if (this.isCapturing && generation === this.captureGeneration) {
                await writer.write(videoFrame);
              }
            } finally {
              videoFrame.close();
            }
          } catch (writeErr) {
            console.warn('[NativeVideoBridge] VideoFrame write failed:', writeErr);
          }
        } else {
          // Canvas fallback
          if (this.ctx && this.canvas) {
            const width = bitmap instanceof ImageBitmap ? bitmap.width : bitmap.displayWidth;
            const height = bitmap instanceof ImageBitmap ? bitmap.height : bitmap.displayHeight;
            if (this.canvas.width !== width || this.canvas.height !== height) {
              this.canvas.width = width;
              this.canvas.height = height;
            }
            this.ctx.drawImage(bitmap, 0, 0, this.canvas.width, this.canvas.height);
          }

          const track = this.activeStream?.getVideoTracks()[0];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (track && typeof (track as any).requestFrame === 'function') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (track as any).requestFrame();
          }
        }
      } catch {
        // Ignore frame decode failure
      } finally {
        if (generation === this.captureGeneration) {
          if (buffer.byteLength > 4 || buffer.byteLength === 4 && new Uint8Array(buffer)[0] === 1) {
            loadMeter.complete(performance.now() - processingStarted);
          }
          this.isDecoding = false;
          if (this.pendingBuffer) pumpNextFrame();
        }
      }
    };

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => fail(), 3000);
        const succeed = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        };
        const fail = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(new Error('A conexão com a captura de vídeo local não foi autenticada.'));
        };
        const wsUrl = `ws://127.0.0.1:${port}`;
        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          try { this.ws?.send(`${accessToken}:${this.sessionId}`); } catch { fail(); }
        };

        this.ws.onmessage = (evt: MessageEvent) => {
          if (!this.isCapturing) return;

          if (evt.data === 'auth-ok') {
            succeed();
            return;
          }

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
            const pressurePercent = loadMeter.receive(evt.data.byteLength > 4,
              Boolean(this.pendingBuffer && this.pendingBuffer.byteLength > 4), performance.now());
            if (pressurePercent !== undefined && !feedbackPending && generation === this.captureGeneration) {
              feedbackPending = true;
              void invoke<number>('report_capture_load', { sessionId: this.sessionId, feedbackToken, pressurePercent })
                .then(effectiveFps => {
                  if (generation === this.captureGeneration) {
                    loadMeter.setEffectiveFps(effectiveFps);
                    if (Number.isFinite(effectiveFps) && effectiveFps >= 15 && effectiveFps <= 120) this.effectiveFps = effectiveFps;
                  }
                })
                .catch(() => {}) // Stopped/replaced sessions reject stale feedback.
                .finally(() => { feedbackPending = false; });
            }
            if (isNativeEncodedPacket(evt.data)) {
              if (nativeEncodingFailed) return;
              receivedNativeEncoding = true;
              // Hardware decoders may need several input frames before producing the first output.
              // Submit asynchronously to the decoder's bounded queue; serialize only track writes.
              void encodedDecoder.decode(evt.data).then(frame => {
                if (!frame) return;
                if (generation !== this.captureGeneration || !this.isCapturing || nativeEncodingFailed) { frame.close(); return; }
                this.latestEncodedFrame?.close(); this.latestEncodedFrame = frame;
                this.pendingBuffer = new Uint8Array([1, 0, 0, 0]).buffer;
                void pumpNextFrame();
              }).catch(error => {
                if (generation !== this.captureGeneration || !this.isCapturing || nativeEncodingFailed) return;
                nativeEncodingFailed = true;
                encodedDecoder.close();
                console.warn('[NativeVideoBridge] Native H264 rejected; retaining native JPEG:', String(error));
                void invoke('control_capture_encoder', {sessionId:this.sessionId,feedbackToken,disable:true}).catch(() => {});
              });
              return;
            }
            if (evt.data.byteLength > 4 && receivedNativeEncoding && !nativeEncodingFailed) {
              nativeEncodingFailed = true;
              encodedDecoder.close();
            }
            // Never allow a 1-byte pacer tick to overwrite an awaiting real video frame!
            if (evt.data.byteLength <= 4 && this.pendingBuffer && this.pendingBuffer.byteLength > 4) {
              return;
            }
            this.pendingBuffer = evt.data;
            pumpNextFrame();
          }
        };

        this.ws.onerror = fail;
        this.ws.onclose = fail;
      });
    } catch (error) {
      await this.stopCapture();
      throw error;
    }

    let stream: MediaStream;
    if (this.trackGenerator) {
      stream = new MediaStream([this.trackGenerator]);
    } else if (this.canvas) {
      stream = this.canvas.captureStream(fps);
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && 'contentHint' in videoTrack) {
        videoTrack.contentHint = 'detail';
      }
    } else {
      stream = new MediaStream();
    }

    this.activeStream = stream;
    try {
      await new Promise<void>((resolve, reject) => {
        const started = performance.now();
        const check = () => {
          if (this.latestBitmap || this.latestEncodedFrame) { resolve(); return; }
          if (!this.isCapturing || performance.now() - started > 6000) {
            reject(new Error('A fonte selecionada não forneceu quadros de vídeo.'));
            return;
          }
          setTimeout(check, 50);
        };
        check();
      });
    } catch (error) {
      await this.stopCapture();
      throw error;
    }
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
      console.warn('[NativeVideoBridge] Screen capture fallback was cancelled or failed:', err);
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

  /** Retain the current MediaStreamTrack while returning to generic native encoding. */
  public async disableNativeEncoding(): Promise<void> {
    if (!this.isCapturingNative() || !this.encoderFeedbackToken) return;
    await invoke('control_capture_encoder', { sessionId: this.sessionId,
      feedbackToken: this.encoderFeedbackToken, disable: true });
  }

  public async stopCapture(): Promise<void> {
    this.captureGeneration++;
    this.encoderFeedbackToken = null;
    this.isCapturing = false;
    this.isDirectGpu = false;
    this.pendingBuffer = null;
    this.isDecoding = false;

    this.encodedDecoder?.close(); this.encodedDecoder = null;
    this.latestEncodedFrame?.close(); this.latestEncodedFrame = null;

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.latestBitmap) {
      try {
        this.latestBitmap.close();
      } catch {}
      this.latestBitmap = null;
    }

    if (this.ws) {
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onopen = null;
      this.ws.onclose = null;
      try {
        this.ws.close(1000);
      } catch {}
      this.ws = null;
    }

    if (this.activeStream) {
      this.activeStream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
      this.activeStream = null;
    }

    if (this.trackWriter) {
      try {
        this.trackWriter.abort().catch(() => {});
      } catch {}
      this.trackWriter = null;
    }

    if (this.trackGenerator) {
      try {
        this.trackGenerator.stop();
      } catch {}
      this.trackGenerator = null;
    }

    if (this.canvas) {
      if (this.canvas.parentNode) {
        this.canvas.parentNode.removeChild(this.canvas);
      }
      this.canvas = null;
    }
    this.ctx = null;
    await invoke('stop_capture_session', { sessionId: this.sessionId }).catch(() => {});
    await invoke('update_stream_pointer_overlay', { sessionId: this.sessionId, visuals: [] }).catch(console.warn);
  }
}
