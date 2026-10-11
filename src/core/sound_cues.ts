/** Original, softly voiced notification cues; no external recordings or playback dependencies. */
export const SOUND_EVENTS = ['message', 'userJoin', 'userLeave', 'screenShareStart', 'screenShareStop', 'watchStreamStart', 'watchStreamStop'] as const;
export type SoundEvent = typeof SOUND_EVENTS[number];
export type SoundPreferences = Record<SoundEvent, boolean>;

interface Note { frequency: number; delay: number; duration: number; level: number; }
const note = (frequency: number, delay: number, duration: number, level: number): Note => ({ frequency, delay, duration, level });
const CUES: Record<SoundEvent, readonly Note[]> = {
  message: [note(440, 0, 0.26, 0.085), note(659.25, 0.025, 0.21, 0.025)],
  userJoin: [note(220, 0, 0.30, 0.075), note(277.18, 0.075, 0.29, 0.065), note(329.63, 0.15, 0.30, 0.06)],
  userLeave: [note(329.63, 0, 0.29, 0.07), note(220, 0.10, 0.32, 0.075)],
  screenShareStart: [note(293.66, 0, 0.32, 0.085), note(440, 0.11, 0.34, 0.075)],
  screenShareStop: [note(440, 0, 0.28, 0.065), note(293.66, 0.09, 0.32, 0.075)],
  watchStreamStart: [note(329.63, 0, 0.20, 0.065), note(392, 0.055, 0.23, 0.045)],
  watchStreamStop: [note(392, 0, 0.19, 0.05), note(329.63, 0.065, 0.23, 0.06)],
};

/** Render the actual playback waveform at the context's sample rate, with silent boundaries. */
export function renderSoundCue(event: SoundEvent, sampleRate: number): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('Unsupported cue sample rate');
  const notes = CUES[event];
  const duration = Math.max(...notes.map(item => item.delay + item.duration));
  const samples = new Float32Array(Math.ceil((duration + 0.015) * sampleRate));
  for (const item of notes) {
    const start = Math.round(item.delay * sampleRate);
    const count = Math.ceil(item.duration * sampleRate);
    for (let i = 0; i < count; i++) {
      const time = i / sampleRate;
      const attack = Math.min(1, time / 0.018);
      const release = Math.min(1, Math.max(0, (item.duration - time) / 0.085));
      const envelope = Math.sin(attack * Math.PI / 2) ** 2
        * Math.sin(release * Math.PI / 2) ** 2 * Math.exp(-time * 7);
      const phase = 2 * Math.PI * item.frequency * time;
      const body = Math.sin(phase) + 0.14 * Math.exp(-time * 18) * Math.sin(phase * 2)
        + 0.025 * Math.exp(-time * 28) * Math.sin(phase * 3);
      samples[start + i] += item.level * envelope * body;
    }
  }
  return samples;
}
