import { SOUND_EVENTS, renderSoundCue, type SoundEvent, type SoundPreferences } from '../core/sound_cues.ts';
export { SOUND_EVENTS, type SoundEvent, type SoundPreferences } from '../core/sound_cues.ts';

// Cached original waveforms share one Web Audio context and preserve per-event preferences.
export class SoundEffectsManager {
  private events: SoundPreferences = Object.fromEntries(SOUND_EVENTS.map((event) => [event, true])) as SoundPreferences;
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private buffers = new Map<SoundEvent, AudioBuffer>();
  private isEnabled: boolean = true;
  private volume: number = 0.6; // Default volume 60%

  constructor() {
    this.loadPreferences();
  }

  private loadPreferences() {
    try {
      const savedEnabled = localStorage.getItem('p2sharer_sfx_enabled');
      if (savedEnabled !== null) {
        this.isEnabled = savedEnabled === 'true';
      }
      const savedEvents = localStorage.getItem('p2sharer_sfx_events');
      if (savedEvents) {
        const parsed: unknown = JSON.parse(savedEvents);
        if (parsed && typeof parsed === 'object') {
          for (const event of SOUND_EVENTS) {
            const value = (parsed as Record<string, unknown>)[event];
            if (typeof value === 'boolean') this.events[event] = value;
          }
        }
      }
      const savedVolume = localStorage.getItem('p2sharer_sfx_volume');
      if (savedVolume !== null) {
        const parsed = parseFloat(savedVolume);
        if (!isNaN(parsed)) {
          this.volume = Math.max(0, Math.min(1, parsed));
        }
      }
    } catch {}
  }

  public setEnabled(enabled: boolean) {
    this.isEnabled = enabled;
    try {
      localStorage.setItem('p2sharer_sfx_enabled', enabled ? 'true' : 'false');
    } catch {}
  }

  public getEnabled(): boolean {
    return this.isEnabled;
  }

  public setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.masterGain && this.audioCtx) {
      this.masterGain.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);
    }
    try {
      localStorage.setItem('p2sharer_sfx_volume', this.volume.toString());
    } catch {}
  }

  public getVolume(): number {
    return this.volume;
  }

  public getEventPreferences(): SoundPreferences { return { ...this.events }; }

  public setEventPreferences(preferences: SoundPreferences) {
    this.events = { ...preferences };
    try { localStorage.setItem('p2sharer_sfx_events', JSON.stringify(this.events)); } catch {}
  }

  public preview(event: SoundEvent, volume: number) {
    this.play(event, Math.max(0, Math.min(1, volume)));
  }

  public playMessage() { this.play('message'); }
  public playUserJoin() { this.play('userJoin'); }
  public playUserLeave() { this.play('userLeave'); }
  public playScreenShareStart() { this.play('screenShareStart'); }
  public playScreenShareStop() { this.play('screenShareStop'); }
  public playWatchStreamStart() { this.play('watchStreamStart'); }
  public playWatchStreamStop() { this.play('watchStreamStop'); }

  private play(event: SoundEvent, previewVolume?: number) {
    if (previewVolume === undefined && (!this.isEnabled || !this.events[event] || this.volume <= 0)) return;
    if (previewVolume !== undefined && previewVolume <= 0) return;
    try {
      const ctx = this.ensureAudioContext();
      if (!ctx || !this.masterGain) return;
      let buffer = this.buffers.get(event);
      if (!buffer) {
        const samples = renderSoundCue(event, ctx.sampleRate);
        buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
        buffer.copyToChannel(samples, 0);
        this.buffers.set(event, buffer);
      }
      // Settings previews have an independent gain, so they cannot change other playing cues.
      const previewGain = previewVolume === undefined ? null : ctx.createGain();
      if (previewGain) {
        previewGain.gain.setValueAtTime(previewVolume!, ctx.currentTime);
        previewGain.connect(ctx.destination);
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(previewGain ?? this.masterGain);
      source.onended = () => { source.disconnect(); previewGain?.disconnect(); };
      source.start();
    } catch (error) {
      console.warn(`[SFX] Could not play ${event}:`, error);
    }
  }

  private ensureAudioContext(): AudioContext | null {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtxClass) return null;
      this.audioCtx = new AudioCtxClass();
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);
      this.masterGain.connect(this.audioCtx.destination);
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
    return this.audioCtx;
  }
}

export const soundEffects = new SoundEffectsManager();
