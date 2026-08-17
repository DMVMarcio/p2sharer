import { listen, UnlistenFn } from '@tauri-apps/api/event';

export interface AudioStreamPayload {
  pcm_base64: string;
  sample_rate: number;
  channels: number;
  rms_level: number;
}

export class AudioBridge {
  private audioCtx: AudioContext | null = null;
  private destNode: MediaStreamAudioDestinationNode | null = null;
  private unlisten: UnlistenFn | null = null;
  private onLevelCallback: ((level: number) => void) | null = null;
  private isCapturing = false;

  public init(onLevel?: (level: number) => void): MediaStreamTrack | null {
    this.onLevelCallback = onLevel || null;
    try {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioContextClass({ sampleRate: 48000 });
      this.destNode = this.audioCtx.createMediaStreamDestination();
      return this.destNode.stream.getAudioTracks()[0] || null;
    } catch (e) {
      console.warn('Web Audio API not initialized:', e);
      return null;
    }
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
      console.warn('Tauri event listening failed (possibly running outside Tauri):', err);
    }
  }

  private playPCMChunk(payload: AudioStreamPayload) {
    if (!this.audioCtx || !this.destNode) return;

    try {
      const binary = atob(payload.pcm_base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const floats = new Float32Array(bytes.buffer);
      const frames = floats.length / (payload.channels || 2);

      const buffer = this.audioCtx.createBuffer(
        payload.channels || 2,
        frames,
        payload.sample_rate || 48000
      );

      // De-interleave channels
      for (let ch = 0; ch < payload.channels; ch++) {
        const chData = buffer.getChannelData(ch);
        for (let i = 0; i < frames; i++) {
          chData[i] = floats[i * payload.channels + ch];
        }
      }

      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.destNode);
      source.start();
    } catch (e) {
      console.error('Error playing PCM chunk in AudioBridge:', e);
    }
  }

  public stop(): void {
    this.isCapturing = false;
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
