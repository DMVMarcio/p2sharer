import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AudioStreamPayload } from '../core/types.ts';

export type { AudioStreamPayload };

export class AudioBridge {
  private audioCtx: AudioContext | null = null;
  private destNode: MediaStreamAudioDestinationNode | null = null;
  private unlisten: UnlistenFn | null = null;
  private onLevelCallback: ((level: number) => void) | null = null;
  private isCapturing = false;
  private nextPlayTime = 0;
  private lastAudioTimestampUs = 0;

  // Preallocated buffer cache to eliminate per-chunk allocations (200 allocs/sec)
  private byteBuffer: Uint8Array = new Uint8Array(16384);
  private floatBuffer: Float32Array = new Float32Array(this.byteBuffer.buffer);

  private ensureBufferCapacity(byteLen: number): void {
    if (this.byteBuffer.byteLength < byteLen) {
      const newCapacity = Math.max(byteLen, this.byteBuffer.byteLength * 2);
      this.byteBuffer = new Uint8Array(newCapacity);
      this.floatBuffer = new Float32Array(this.byteBuffer.buffer);
    }
  }

  public init(onLevel?: (level: number) => void): MediaStreamTrack | null {
    this.onLevelCallback = onLevel || null;
    try {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioContextClass({ sampleRate: 48000 });
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
      this.destNode = this.audioCtx.createMediaStreamDestination();
      this.nextPlayTime = 0;
      return this.destNode.stream.getAudioTracks()[0] || null;
    } catch (e) {
      console.warn('Web Audio API not initialized:', e);
      return null;
    }
  }

  public async startCapture(
    mode: string = 'exclude',
    targetPids: number[] = [],
    targetNames: string[] = []
  ): Promise<MediaStreamTrack | null> {
    const track = this.init();
    await this.startListening();
    try {
      await invoke('start_audio_capture', {
        config: {
          mode,
          target_pids: targetPids,
          target_names: targetNames,
          sample_rate: 48000,
        },
      });
    } catch (err) {
      console.warn('Rust start_audio_capture warning:', err);
    }
    return track;
  }

  public async startListening(): Promise<void> {
    if (this.isCapturing) return;
    this.isCapturing = true;

    try {
      this.unlisten = await listen<AudioStreamPayload>('p2sharer://audio-stream', (event) => {
        const payload = event.payload;
        if (this.onLevelCallback) {
          this.onLevelCallback(payload.rms_level);
        }

        if (this.audioCtx && this.destNode && payload.pcm_base64) {
          this.playPCMChunk(payload);
        }
      });
    } catch (err) {
      console.warn('Tauri audio event listening failed:', err);
    }
  }

  private playPCMChunk(payload: AudioStreamPayload) {
    if (!this.audioCtx || !this.destNode || !payload.pcm_base64) return;

    try {
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }

      if (typeof payload.timestamp_us === 'number') {
        this.lastAudioTimestampUs = payload.timestamp_us;
      }

      const binary = atob(payload.pcm_base64);
      const len = binary.length;
      if (len === 0) return;

      this.ensureBufferCapacity(len);

      for (let i = 0; i < len; i++) {
        this.byteBuffer[i] = binary.charCodeAt(i);
      }

      const channels = payload.channels || 2;
      const sampleRate = payload.sample_rate || 48000;
      const totalFloats = len >> 2;
      const frames = Math.floor(totalFloats / channels);
      if (frames === 0) return;

      const buffer = this.audioCtx.createBuffer(channels, frames, sampleRate);

      // Unrolled fast copy for standard stereo channels
      if (channels === 2) {
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);
        for (let i = 0, j = 0; i < frames; i++, j += 2) {
          left[i] = this.floatBuffer[j]!;
          right[i] = this.floatBuffer[j + 1]!;
        }
      } else {
        for (let ch = 0; ch < channels; ch++) {
          const chData = buffer.getChannelData(ch);
          for (let i = 0; i < frames; i++) {
            chData[i] = this.floatBuffer[i * channels + ch]!;
          }
        }
      }

      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.destNode);

      // Clean up Web Audio node lifecycle on ended
      source.onended = () => {
        source.disconnect();
        source.buffer = null;
      };

      const currentTime = this.audioCtx.currentTime;
      const TARGET_LEAD = 0.012; // 12ms target lead time
      const MAX_BACKLOG = 0.060; // 60ms backlog ceiling

      // Smooth scheduling: only re-anchor if audio clock has drifted outside allowable window
      // Use 25ms grace window to prevent false re-anchoring on minor OS scheduling jitter
      if (this.nextPlayTime < currentTime - 0.025 || this.nextPlayTime > currentTime + MAX_BACKLOG) {
        this.nextPlayTime = currentTime + TARGET_LEAD;
      }

      const scheduleTime = Math.max(currentTime, this.nextPlayTime);
      source.start(scheduleTime);
      this.nextPlayTime = scheduleTime + buffer.duration;
    } catch (e) {
      console.error('Error playing PCM chunk in AudioBridge:', e);
    }
  }

  public getLastTimestampUs(): number {
    return this.lastAudioTimestampUs;
  }

  public stop(): void {
    this.isCapturing = false;
    this.nextPlayTime = 0;
    this.lastAudioTimestampUs = 0;
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    this.destNode = null;
  }
}
