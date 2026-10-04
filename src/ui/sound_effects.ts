// Sound Effects Manager using Web Audio API
// Generates crisp, modern and pleasant auditory cues with zero external audio assets and zero latency.

export const SOUND_EVENTS = ['message', 'userJoin', 'userLeave', 'screenShareStart', 'screenShareStop', 'watchStreamStart', 'watchStreamStop'] as const;
export type SoundEvent = typeof SOUND_EVENTS[number];
export type SoundPreferences = Record<SoundEvent, boolean>;

export class SoundEffectsManager {
  private events: SoundPreferences = Object.fromEntries(SOUND_EVENTS.map((event) => [event, true])) as SoundPreferences;
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
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
    const enabled = this.isEnabled;
    const preferences = this.events;
    const savedVolume = this.volume;
    this.isEnabled = true;
    this.events = { ...this.events, [event]: true };
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.masterGain && this.audioCtx) this.masterGain.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);
    try {
      const players = {
        message: () => this.playMessage(), userJoin: () => this.playUserJoin(), userLeave: () => this.playUserLeave(),
        screenShareStart: () => this.playScreenShareStart(), screenShareStop: () => this.playScreenShareStop(),
        watchStreamStart: () => this.playWatchStreamStart(), watchStreamStop: () => this.playWatchStreamStop(),
      };
      players[event]();
    } finally {
      this.isEnabled = enabled;
      this.events = preferences;
      this.volume = savedVolume;
    }
  }

  public playMessage() {
    const ctx = this.ensureAudioContext('message');
    if (!ctx || !this.masterGain) return;
    try {
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.connect(this.masterGain);
      const tone = ctx.createOscillator();
      tone.type = 'sine';
      tone.frequency.setValueAtTime(880, now);
      tone.frequency.setValueAtTime(1174.66, now + 0.08);
      tone.connect(gain);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.25, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
      tone.onended = () => { tone.disconnect(); gain.disconnect(); };
      tone.start(now);
      tone.stop(now + 0.25);
    } catch (error) { console.warn('[SFX] Error playing message sound:', error); }
  }

  private ensureAudioContext(event: SoundEvent): AudioContext | null {
    if (!this.isEnabled || !this.events[event] || this.volume <= 0) {
      return null;
    }

    if (this.masterGain && this.audioCtx) this.masterGain.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);

    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtxClass) return null;
      this.audioCtx = new AudioCtxClass();
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);
      this.masterGain.connect(this.audioCtx.destination);
    }

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    return this.audioCtx;
  }

  /**
   * 1. Screen Share Started
   * Pleasant ascending two-tone chime (Eb5 -> Bb5)
   */
  public playScreenShareStart() {
    const ctx = this.ensureAudioContext('screenShareStart');
    if (!ctx || !this.masterGain) return;

    try {
      const now = ctx.currentTime;
      const gainNode = ctx.createGain();
      gainNode.connect(this.masterGain);

      // Tone 1: Eb5 (622.25 Hz)
      const osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(622.25, now);
      osc1.connect(gainNode);

      // Tone 2: Bb5 (932.33 Hz)
      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(932.33, now + 0.1);
      osc2.connect(gainNode);

      // Envelope: smooth attack, gentle transition, soft decay
      gainNode.gain.setValueAtTime(0.0001, now);
      gainNode.gain.exponentialRampToValueAtTime(0.35, now + 0.02);
      gainNode.gain.setValueAtTime(0.28, now + 0.09);
      gainNode.gain.exponentialRampToValueAtTime(0.45, now + 0.12);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);

      osc1.start(now);
      osc1.stop(now + 0.1);

      osc2.start(now + 0.1);
      osc2.stop(now + 0.42);
    } catch (err) {
      console.warn('[SFX] Error playing screen share start sound:', err);
    }
  }

  /**
   * 2. Screen Share Stopped
   * Descending two-tone cue (Bb5 -> Eb5)
   */
  public playScreenShareStop() {
    const ctx = this.ensureAudioContext('screenShareStop');
    if (!ctx || !this.masterGain) return;

    try {
      const now = ctx.currentTime;
      const gainNode = ctx.createGain();
      gainNode.connect(this.masterGain);

      // Tone 1: Bb5 (932.33 Hz)
      const osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(932.33, now);
      osc1.connect(gainNode);

      // Tone 2: Eb5 (622.25 Hz)
      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(622.25, now + 0.09);
      osc2.connect(gainNode);

      gainNode.gain.setValueAtTime(0.0001, now);
      gainNode.gain.exponentialRampToValueAtTime(0.35, now + 0.02);
      gainNode.gain.setValueAtTime(0.26, now + 0.08);
      gainNode.gain.exponentialRampToValueAtTime(0.38, now + 0.11);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);

      osc1.start(now);
      osc1.stop(now + 0.09);

      osc2.start(now + 0.09);
      osc2.stop(now + 0.38);
    } catch (err) {
      console.warn('[SFX] Error playing screen share stop sound:', err);
    }
  }

  /**
   * 3. Started Watching Stream
   * Crisp, subtle upward chirp / pop (480Hz -> 880Hz)
   */
  public playWatchStreamStart() {
    const ctx = this.ensureAudioContext('watchStreamStart');
    if (!ctx || !this.masterGain) return;

    try {
      const now = ctx.currentTime;
      const gainNode = ctx.createGain();
      gainNode.connect(this.masterGain);

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(480, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.08);
      osc.connect(gainNode);

      gainNode.gain.setValueAtTime(0.0001, now);
      gainNode.gain.exponentialRampToValueAtTime(0.3, now + 0.015);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

      osc.start(now);
      osc.stop(now + 0.14);
    } catch (err) {
      console.warn('[SFX] Error playing watch stream start sound:', err);
    }
  }

  /**
   * 4. Stopped Watching Stream
   * Subtle soft downward chirp / pop-out (780Hz -> 360Hz)
   */
  public playWatchStreamStop() {
    const ctx = this.ensureAudioContext('watchStreamStop');
    if (!ctx || !this.masterGain) return;

    try {
      const now = ctx.currentTime;
      const gainNode = ctx.createGain();
      gainNode.connect(this.masterGain);

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(780, now);
      osc.frequency.exponentialRampToValueAtTime(360, now + 0.08);
      osc.connect(gainNode);

      gainNode.gain.setValueAtTime(0.0001, now);
      gainNode.gain.exponentialRampToValueAtTime(0.28, now + 0.015);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);

      osc.start(now);
      osc.stop(now + 0.13);
    } catch (err) {
      console.warn('[SFX] Error playing watch stream stop sound:', err);
    }
  }

  /**
   * 5. User Joined Room
   * Bright, pleasant harmonic entry chime (C5 -> G5 chord progression)
   */
  public playUserJoin() {
    const ctx = this.ensureAudioContext('userJoin');
    if (!ctx || !this.masterGain) return;

    try {
      const now = ctx.currentTime;
      const gainNode = ctx.createGain();
      gainNode.connect(this.masterGain);

      // First note: C5 (523.25 Hz)
      const osc1 = ctx.createOscillator();
      osc1.type = 'triangle';
      osc1.frequency.setValueAtTime(523.25, now);
      osc1.connect(gainNode);

      // Second note: G5 (783.99 Hz)
      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(783.99, now + 0.08);
      osc2.connect(gainNode);

      // Third overtone note: C6 (1046.50 Hz)
      const osc3 = ctx.createOscillator();
      osc3.type = 'sine';
      osc3.frequency.setValueAtTime(1046.5, now + 0.08);
      osc3.connect(gainNode);

      gainNode.gain.setValueAtTime(0.0001, now);
      gainNode.gain.exponentialRampToValueAtTime(0.35, now + 0.02);
      gainNode.gain.setValueAtTime(0.28, now + 0.07);
      gainNode.gain.exponentialRampToValueAtTime(0.4, now + 0.1);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

      osc1.start(now);
      osc1.stop(now + 0.08);

      osc2.start(now + 0.08);
      osc2.stop(now + 0.45);

      osc3.start(now + 0.08);
      osc3.stop(now + 0.45);
    } catch (err) {
      console.warn('[SFX] Error playing user join sound:', err);
    }
  }

  /**
   * 6. User Left Room
   * Soft descending exit chime (G5 -> C5)
   */
  public playUserLeave() {
    const ctx = this.ensureAudioContext('userLeave');
    if (!ctx || !this.masterGain) return;

    try {
      const now = ctx.currentTime;
      const gainNode = ctx.createGain();
      gainNode.connect(this.masterGain);

      // Note 1: G5 (783.99 Hz)
      const osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(783.99, now);
      osc1.connect(gainNode);

      // Note 2: C5 (523.25 Hz)
      const osc2 = ctx.createOscillator();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(523.25, now + 0.08);
      osc2.connect(gainNode);

      gainNode.gain.setValueAtTime(0.0001, now);
      gainNode.gain.exponentialRampToValueAtTime(0.32, now + 0.02);
      gainNode.gain.setValueAtTime(0.24, now + 0.07);
      gainNode.gain.exponentialRampToValueAtTime(0.35, now + 0.1);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);

      osc1.start(now);
      osc1.stop(now + 0.08);

      osc2.start(now + 0.08);
      osc2.stop(now + 0.42);
    } catch (err) {
      console.warn('[SFX] Error playing user leave sound:', err);
    }
  }
}

export const soundEffects = new SoundEffectsManager();
