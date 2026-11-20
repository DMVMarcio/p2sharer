import { soundEffects } from '../ui/sound_effects.ts';

/**
 * Synthesizes warm, tactile wooden tabletop cues for board games.
 * Respects the global SFX toggle and volume managed by `soundEffects`.
 */
class BoardGameSounds {
  private ctx: AudioContext | null = null;

  private getContext(): AudioContext | null {
    if (!soundEffects.getEnabled() || soundEffects.getVolume() <= 0) return null;
    if (typeof window === 'undefined') return null;
    try {
      if (!this.ctx) {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) return null;
        this.ctx = new AudioCtx();
      }
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    } catch {
      return null;
    }
  }

  private gainLevel(multiplier = 1): number {
    return Math.max(0, Math.min(1, soundEffects.getVolume() * multiplier));
  }

  private playWoodTap(ctx: AudioContext, delay: number, startHz: number, endHz: number, duration: number, level: number) {
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(startHz, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, endHz), now + duration);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(level, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.01);

    // Subtle wooden knock transient
    const bufferLen = Math.max(1, Math.floor(ctx.sampleRate * 0.018));
    const noiseBuf = ctx.createBuffer(1, bufferLen, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufferLen; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferLen * 0.35));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1450, now);
    filter.Q.setValueAtTime(2.2, now);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(level * 0.42, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noise.start(now);
  }

  private playTone(
    ctx: AudioContext,
    delay: number,
    freq: number,
    duration: number,
    level: number,
    type: OscillatorType = 'sine',
  ) {
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(level, now + 0.014);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.015);
  }

  playMove(): void {
    const ctx = this.getContext();
    if (!ctx) return;
    this.playWoodTap(ctx, 0, 220, 92, 0.055, this.gainLevel(0.24));
  }

  playSettle(index = 0): void {
    const ctx = this.getContext();
    if (!ctx) return;
    const semitoneOffsets = [0, 2, 4, 1, 5, 3, -1, 2];
    const offset = semitoneOffsets[index % semitoneOffsets.length];
    const pitchFactor = Math.pow(2, offset / 24);
    this.playWoodTap(
      ctx,
      0,
      Math.round(235 * pitchFactor),
      Math.round(98 * pitchFactor),
      0.044,
      this.gainLevel(0.145),
    );
  }

  playCapture(): void {
    const ctx = this.getContext();
    if (!ctx) return;
    const lvl = this.gainLevel(0.26);
    this.playWoodTap(ctx, 0, 290, 125, 0.045, lvl * 0.85);
    this.playWoodTap(ctx, 0.028, 195, 78, 0.075, lvl);
  }

  playPromote(): void {
    const ctx = this.getContext();
    if (!ctx) return;
    const lvl = this.gainLevel(0.16);
    this.playTone(ctx, 0, 523.25, 0.16, lvl, 'triangle');
    this.playTone(ctx, 0.07, 659.25, 0.18, lvl, 'triangle');
    this.playTone(ctx, 0.14, 783.99, 0.24, lvl * 1.1, 'sine');
  }

  playCheck(): void {
    const ctx = this.getContext();
    if (!ctx) return;
    const lvl = this.gainLevel(0.16);
    this.playTone(ctx, 0, 440, 0.18, lvl, 'triangle');
    this.playTone(ctx, 0.06, 659.25, 0.24, lvl * 0.9, 'sine');
  }

  playVictory(): void {
    const ctx = this.getContext();
    if (!ctx) return;
    const lvl = this.gainLevel(0.17);
    this.playTone(ctx, 0, 523.25, 0.22, lvl, 'triangle');
    this.playTone(ctx, 0.08, 659.25, 0.24, lvl, 'triangle');
    this.playTone(ctx, 0.16, 783.99, 0.28, lvl, 'triangle');
    this.playTone(ctx, 0.24, 1046.5, 0.42, lvl * 1.1, 'sine');
  }

  playDraw(): void {
    const ctx = this.getContext();
    if (!ctx) return;
    const lvl = this.gainLevel(0.14);
    this.playTone(ctx, 0, 392, 0.18, lvl, 'sine');
    this.playTone(ctx, 0.1, 349.23, 0.26, lvl * 0.9, 'sine');
  }

  playRoomEnter(): void {
    const ctx = this.getContext();
    if (!ctx) return;
    const lvl = this.gainLevel(0.1);
    this.playTone(ctx, 0, 329.63, 0.14, lvl, 'sine');
    this.playTone(ctx, 0.055, 440, 0.18, lvl, 'sine');
  }

  playRoomLeave(): void {
    const ctx = this.getContext();
    if (!ctx) return;
    const lvl = this.gainLevel(0.09);
    this.playTone(ctx, 0, 440, 0.13, lvl, 'sine');
    this.playTone(ctx, 0.05, 329.63, 0.16, lvl, 'sine');
  }
}

export const boardGameSounds = new BoardGameSounds();
