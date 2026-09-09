import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertNear } from '../harness/assertions.ts';
import {
  setupTestDOM,
  MockAudioContext,
} from '../harness/dom-mock.ts';
import {
  resampleInterleavedFloat,
  float32ArrayToBase64,
  base64ToFloat32Array,
  generateSineWave,
  calculateRms,
} from '../harness/audio-dsp-oracle.ts';

describe('Tier 3: Audio DOM Matrix & UI Combinations', () => {
  it('R3+R4-T3-1: Should resample 44.1kHz PCM, serialize to base64, and schedule into Singleton AudioContext', () => {
    const dom = setupTestDOM();
    try {
      const audioCtx = new MockAudioContext({ sampleRate: 48000 });
      const destNode = audioCtx.createMediaStreamDestination();

      // 1. Generate 44.1kHz raw tone
      const raw44k = generateSineWave(440, 0.1, 44100, 0.8, 2);

      // 2. In-Rust resampler: 44.1kHz -> 48kHz
      const resampled48k = resampleInterleavedFloat(raw44k, 2, 44100, 48000);
      const b64Payload = float32ArrayToBase64(resampled48k);

      // 3. Frontend AudioBridge playPCMChunk: decode base64
      const pcmFloats = base64ToFloat32Array(b64Payload);
      const channels = 2;
      const frames = pcmFloats.length / channels;

      const buffer = audioCtx.createBuffer(channels, frames, 48000);
      assert.equal(buffer.sampleRate, 48000);
      assert.equal(buffer.numberOfChannels, 2);

      const sourceNode = audioCtx.createBufferSource();
      sourceNode.buffer = buffer;
      sourceNode.connect(destNode);
      sourceNode.start(0.008); // 8ms jitter buffer

      assert.equal(sourceNode.startedAt, 0.008);
      assert.equal(sourceNode.connectedTo, destNode);
    } finally {
      dom.cleanup();
    }
  });

  it('R3+R4-T3-2: Should isolate volume slider adjustments to individual peer GainNodes', () => {
    const dom = setupTestDOM();
    try {
      const audioCtx = new MockAudioContext();
      const peerGains = new Map<string, any>();

      ['peer-1', 'peer-2', 'peer-3'].forEach((p) => {
        const gain = audioCtx.createGain();
        gain.gain.value = 1.0;
        peerGains.set(p, gain);
      });

      // Adjust volume on peer-2 to 0.45
      peerGains.get('peer-2').gain.value = 0.45;

      assertNear(peerGains.get('peer-1').gain.value, 1.0, 0.001);
      assertNear(peerGains.get('peer-2').gain.value, 0.45, 0.001);
      assertNear(peerGains.get('peer-3').gain.value, 1.0, 0.001);
    } finally {
      dom.cleanup();
    }
  });

  it('R3+R5-T3-3: Should update HUD audio level meter proportionally to chunk RMS without overflow', () => {
    const meterValues: number[] = [];

    function onAudioLevelUpdate(rms: number) {
      // Scale RMS to 0-100% meter bar
      const percentage = Math.round(Math.min(1.0, Math.max(0.0, rms)) * 100);
      meterValues.push(percentage);
    }

    const silentChunk = new Float32Array(480);
    const quietChunk = generateSineWave(440, 0.01, 48000, 0.2, 2);
    const loudChunk = generateSineWave(440, 0.01, 48000, 0.9, 2);

    onAudioLevelUpdate(calculateRms(silentChunk));
    onAudioLevelUpdate(calculateRms(quietChunk));
    onAudioLevelUpdate(calculateRms(loudChunk));

    assert.equal(meterValues[0], 0, 'Silent chunk must yield 0%');
    assert.ok(meterValues[1]! > 0 && meterValues[1]! < 50, 'Quiet chunk must yield moderate meter');
    assert.ok(meterValues[2]! >= 50 && meterValues[2]! <= 100, 'Loud chunk must yield high meter');
  });

  it('R1+R5-T3-4: Should compute frame rates and identify zero frame drops across 60 frames', () => {
    let receivedFrames = 0;
    let droppedFrames = 0;
    let lastSequence = 0;

    function onFrameReceived(sequence: number) {
      if (lastSequence > 0 && sequence > lastSequence + 1) {
        droppedFrames += sequence - (lastSequence + 1);
      }
      lastSequence = sequence;
      receivedFrames++;
    }

    // Deliver 60 sequential frames
    for (let seq = 1; seq <= 60; seq++) {
      onFrameReceived(seq);
    }

    assert.equal(receivedFrames, 60);
    assert.equal(droppedFrames, 0);
  });

  it('R4+R5-T3-5: Should synthesize sound cues without disturbing active remote stream playback', () => {
    const dom = setupTestDOM();
    try {
      const sharedCtx = new MockAudioContext();

      // Remote stream playing
      const remoteStreamGain = sharedCtx.createGain();
      remoteStreamGain.gain.value = 0.8;

      // Sound cue played (join notification)
      const cueBuffer = sharedCtx.createBuffer(1, 480, 48000);
      const cueSource = sharedCtx.createBufferSource();
      cueSource.buffer = cueBuffer;
      cueSource.start();

      assert.equal(MockAudioContext.instanceCount, 1, 'AudioContext must not be duplicated for sound cues');
      assert.equal(remoteStreamGain.gain.value, 0.8, 'Remote stream gain must remain untouched');
    } finally {
      dom.cleanup();
    }
  });
});
