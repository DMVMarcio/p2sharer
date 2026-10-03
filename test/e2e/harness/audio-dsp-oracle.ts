/**
 * Audio DSP Mathematical Reference Oracle
 * Implements authoritative mathematical formulas for:
 * 1. Resampling via linear interpolation and ratio derivation
 * 2. RMS amplitude calculation
 * 3. 16-bit signed integer to 32-bit float normalization
 * 4. Little-endian byte serialization / deserialization
 * 5. Process filtering tree resolution
 */

export function calculateRms(samples: Float32Array | number[]): number {
  if (samples.length === 0) return 0.0;
  let sumSq = 0.0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  return Math.min(1.0, Math.max(0.0, rms));
}

/**
 * Normalizes 16-bit signed integer PCM [-32768, 32767] to float [-1.0, 1.0]
 * Exact match with src-tauri/src/audio_loopback.rs line 498
 */
export function pcm16ToFloat32(int16Samples: Int16Array | number[]): Float32Array {
  const floats = new Float32Array(int16Samples.length);
  for (let i = 0; i < int16Samples.length; i++) {
    floats[i] = int16Samples[i]! / 32768.0;
  }
  return floats;
}

/**
 * Resamples multi-channel interleaved float audio from inSampleRate to outSampleRate.
 * Uses high-precision linear interpolation.
 */
export function resampleInterleavedFloat(
  input: Float32Array,
  channels: number,
  inSampleRate: number,
  outSampleRate: number
): Float32Array {
  if (inSampleRate === outSampleRate) {
    return new Float32Array(input);
  }

  const inFrames = input.length / channels;
  const outFrames = Math.round((inFrames * outSampleRate) / inSampleRate);
  const output = new Float32Array(outFrames * channels);
  const ratio = (inFrames - 1) / Math.max(1, outFrames - 1);

  for (let outFrame = 0; outFrame < outFrames; outFrame++) {
    const inPos = outFrame * ratio;
    const inFrame0 = Math.floor(inPos);
    const inFrame1 = Math.min(inFrame0 + 1, inFrames - 1);
    const frac = inPos - inFrame0;

    for (let ch = 0; ch < channels; ch++) {
      const s0 = input[inFrame0 * channels + ch] || 0;
      const s1 = input[inFrame1 * channels + ch] || 0;
      output[outFrame * channels + ch] = s0 + frac * (s1 - s0);
    }
  }

  return output;
}

/**
 * Encodes Float32Array into Little-Endian bytes and then Base64 string.
 * Exact match with Rust LittleEndian::write_f32_into + BASE64.encode
 */
export function float32ArrayToBase64(samples: Float32Array): string {
  const buffer = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  return buffer.toString('base64');
}

/**
 * Decodes Base64 string back into Little-Endian Float32Array.
 * Exact match with src/audio/audio_bridge.ts playPCMChunk
 */
export function base64ToFloat32Array(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  const floats = new Float32Array(buf.length / 4);
  for (let i = 0; i < floats.length; i++) {
    floats[i] = buf.readFloatLE(i * 4);
  }
  return floats;
}

/**
 * Generates pure mathematical sine wave signal.
 */
export function generateSineWave(
  freqHz: number,
  durationSec: number,
  sampleRate: number = 48000,
  amplitude: number = 1.0,
  channels: number = 2
): Float32Array {
  const totalFrames = Math.round(durationSec * sampleRate);
  const buffer = new Float32Array(totalFrames * channels);
  const angularSpeed = 2 * Math.PI * freqHz;

  for (let f = 0; f < totalFrames; f++) {
    const t = f / sampleRate;
    const val = amplitude * Math.sin(angularSpeed * t);
    for (let ch = 0; ch < channels; ch++) {
      buffer[f * channels + ch] = val;
    }
  }

  return buffer;
}

export interface ProcessNode {
  pid: number;
  name: string;
  parentPid: number;
}

/**
 * Resolves process inclusion/exclusion tree.
 * Matches Windows loopback process tree semantics.
 */
export function resolveProcessFilter(
  allProcesses: ProcessNode[],
  targetNames: string[],
  targetPids: number[],
  mode: 'full' | 'include' | 'exclude'
): Set<number> {
  if (mode === 'full') {
    return new Set(allProcesses.map((p) => p.pid));
  }

  // Find root target PIDs (either by PID directly or by executable name)
  const rootPids = new Set<number>();
  targetPids.forEach((p) => rootPids.add(p));

  const lowerNames = targetNames.map((n) => n.toLowerCase());
  allProcesses.forEach((p) => {
    if (lowerNames.includes(p.name.toLowerCase())) {
      rootPids.add(p.pid);
    }
  });

  // Resolve descendants (child processes)
  const treePids = new Set<number>(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of allProcesses) {
      if (!treePids.has(p.pid) && treePids.has(p.parentPid)) {
        treePids.add(p.pid);
        changed = true;
      }
    }
  }

  if (mode === 'include') {
    // If include mode with 0 apps, silence
    if (rootPids.size === 0) {
      return new Set();
    }
    return treePids;
  } else {
    // Exclude mode
    const allowed = new Set<number>();
    allProcesses.forEach((p) => {
      if (!treePids.has(p.pid)) {
        allowed.add(p.pid);
      }
    });
    return allowed;
  }
}
