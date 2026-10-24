import type { PeerAudioSinkState } from '../core/types.ts';

export class AudioContextManager {
  private static instance: AudioContextManager | null = null;
  private audioCtx: AudioContext | null = null;
  private peerSinks: Map<string, PeerAudioSinkState> = new Map();
  private peerAudioTracks = new Map<string, MediaStreamTrack[]>();
  private peerPullElements = new Map<string, HTMLAudioElement>();
  private unlockListenerAttached = false;

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
    this.safeResumeAudioContext();
    return this.audioCtx;
  }

  private safeResumeAudioContext(): void {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch((err) => {
        if (err?.name === 'NotAllowedError') {
          this.ensureUserInteractionUnlock();
        }
      });
    }
  }

  private safePlayPullElement(element: HTMLAudioElement): void {
    const promise = element.play();
    if (promise !== undefined) {
      promise.catch((err) => {
        if (err?.name === 'NotAllowedError') {
          this.ensureUserInteractionUnlock();
        }
      });
    }
  }

  private ensureUserInteractionUnlock(): void {
    if (this.unlockListenerAttached || typeof window === 'undefined') return;
    this.unlockListenerAttached = true;
    const unlock = () => {
      this.unlockListenerAttached = false;
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      window.removeEventListener('touchstart', unlock, true);
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
      this.peerPullElements.forEach((el) => {
        if (el.paused) {
          el.play().catch(() => {});
        }
      });
    };
    window.addEventListener('pointerdown', unlock, { capture: true, once: true });
    window.addEventListener('keydown', unlock, { capture: true, once: true });
    window.addEventListener('touchstart', unlock, { capture: true, once: true });
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

    let pullElement = this.peerPullElements.get(peerId);
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
        if (!pullElement) {
          pullElement = document.createElement('audio');
          pullElement.autoplay = true;
          pullElement.setAttribute('playsinline', 'true');
          pullElement.volume = 0;
          pullElement.hidden = true;
          document.body.appendChild(pullElement);
          this.peerPullElements.set(peerId, pullElement);
        }
        pullElement.srcObject = audioStream;
        this.safePlayPullElement(pullElement);
      } catch (err) {
        console.warn('Failed to connect media stream source for peer:', peerId, err);
      }
    } else if (pullElement && pullElement.paused) {
      this.safePlayPullElement(pullElement);
    }

    this.safeResumeAudioContext();
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
        this.safeResumeAudioContext();
      }
      const pullElement = this.peerPullElements.get(peerId);
      if (pullElement && pullElement.paused && !state.isMuted && state.volume > 0) {
        this.safePlayPullElement(pullElement);
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
