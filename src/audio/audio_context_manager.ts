import type { PeerAudioSinkState } from '../core/types.ts';

export class AudioContextManager {
  private static instance: AudioContextManager | null = null;
  private audioCtx: AudioContext | null = null;
  private peerSinks: Map<string, PeerAudioSinkState> = new Map();

  public static getInstance(): AudioContextManager {
    if (!AudioContextManager.instance) {
      AudioContextManager.instance = new AudioContextManager();
    }
    return AudioContextManager.instance;
  }

  public getAudioContext(): AudioContext {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioContextClass();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  public attachPeerAudio(peerId: string, stream: MediaStream): PeerAudioSinkState {
    const ctx = this.getAudioContext();
    let state = this.peerSinks.get(peerId);

    if (!state) {
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1.0;
      gainNode.connect(ctx.destination);
      state = {
        audioCtx: ctx,
        source: null,
        gainNode,
        streamId: '',
        volume: 100,
        isMuted: false,
      };
      this.peerSinks.set(peerId, state);
    }

    if (stream.getAudioTracks().length === 0) {
      return state;
    }

    if (state.streamId !== stream.id || !state.source) {
      if (state.source) {
        try {
          state.source.disconnect();
        } catch {}
      }
      try {
        state.source = ctx.createMediaStreamSource(stream);
        state.source.connect(state.gainNode);
        state.streamId = stream.id;
      } catch (err) {
        console.warn('Failed to connect media stream source for peer:', peerId, err);
      }
    }

    state.gainNode.gain.value = state.isMuted ? 0 : state.volume / 100;
    return state;
  }

  public detachPeerAudio(peerId: string): void {
    const state = this.peerSinks.get(peerId);
    if (state) {
      if (state.source) {
        try {
          state.source.disconnect();
        } catch {}
      }
      try {
        state.gainNode.disconnect();
      } catch {}
      this.peerSinks.delete(peerId);
    }
  }

  public setPeerVolume(peerId: string, volume: number, isMuted?: boolean): void {
    const state = this.peerSinks.get(peerId);
    if (state) {
      state.volume = Math.max(0, Math.min(100, volume));
      if (isMuted !== undefined) {
        state.isMuted = isMuted;
      }
      state.gainNode.gain.value = state.isMuted ? 0 : state.volume / 100;
      if (this.audioCtx && this.audioCtx.state === 'suspended' && !state.isMuted && state.volume > 0) {
        this.audioCtx.resume().catch(() => {});
      }
    }
  }

  public getPeerVolumeState(peerId: string): { volume: number; isMuted: boolean } {
    const state = this.peerSinks.get(peerId);
    if (state) {
      return { volume: state.volume, isMuted: state.isMuted };
    }
    return { volume: 100, isMuted: false };
  }

  public cleanup(): void {
    this.peerSinks.forEach((_, peerId) => this.detachPeerAudio(peerId));
    this.peerSinks.clear();
    if (this.audioCtx) {
      try {
        this.audioCtx.close().catch(() => {});
      } catch {}
      this.audioCtx = null;
    }
  }
}

export const audioContextManager = AudioContextManager.getInstance();
