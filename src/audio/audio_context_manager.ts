import type { PeerAudioSinkState } from '../core/types.ts';

export class AudioContextManager {
  private static instance: AudioContextManager | null = null;
  private audioCtx: AudioContext | null = null;
  private peerSinks: Map<string, PeerAudioSinkState> = new Map();
  private peerAudioTracks = new Map<string, MediaStreamTrack[]>();
  private peerPullElements = new Map<string, HTMLAudioElement>();

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

    const tracks = stream.getAudioTracks().filter(track => track.readyState !== 'ended');
    if (tracks.length === 0) {
      return state;
    }

    const previous = this.peerAudioTracks.get(peerId);
    if (!state.source || !previous || tracks.length !== previous.length || tracks.some(track => !previous.includes(track))) {
      if (state.source) {
        try {
          state.source.disconnect();
        } catch {}
      }
      try {
        const audioStream = new MediaStream(tracks);
        state.source = ctx.createMediaStreamSource(audioStream);
        state.source.connect(state.gainNode);
        state.streamId = stream.id;
        this.peerAudioTracks.set(peerId, tracks);
        // Chromium remote WebRTC audio needs an active media-element sink to
        // keep pulling samples into Web Audio after the visible video enters PiP.
        // Zero element volume avoids a second audible path; gain owns the volume.
        let element = this.peerPullElements.get(peerId);
        if (!element) {
          element = document.createElement('audio');
          element.autoplay = true;
          element.volume = 0;
          element.hidden = true;
          document.body.appendChild(element);
          this.peerPullElements.set(peerId, element);
        }
        element.srcObject = audioStream;
        void element.play().catch(() => {});
      } catch (err) {
        console.warn('Failed to connect media stream source for peer:', peerId, err);
      }
    }

    state.gainNode.gain.value = state.isMuted ? 0 : state.volume / 100;
    return state;
  }

  public detachPeerAudio(peerId: string): void {
    const element = this.peerPullElements.get(peerId);
    if (element) {
      element.pause();
      element.srcObject = null;
      element.remove();
      this.peerPullElements.delete(peerId);
    }
    this.peerAudioTracks.delete(peerId);
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
