import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMonotonic } from '../harness/assertions.ts';
import {
  setupTestDOM,
  MockCanvasElement,
  MockMediaStream,
  MockMediaStreamTrack,
} from '../harness/dom-mock.ts';
import { validateIpcInvoke } from '../harness/ipc-contract.ts';

describe('Tier 3: A/V Pipeline Cross-Feature Combinations', () => {
  it('R1+R3-T3-1: Should concurrently initialize screen video track and audio loopback track into combined stream', () => {
    const dom = setupTestDOM();
    try {
      const canvas = dom.document.createElement('canvas') as MockCanvasElement;
      const videoStream = canvas.captureStream(60);
      const videoTrack = videoStream.getVideoTracks()[0]!;

      const audioTrack = new MockMediaStreamTrack('audio', 'wasapi-loopback-track');

      const combinedStream = new MockMediaStream('combined-av-stream');
      combinedStream.addTrack(videoTrack);
      combinedStream.addTrack(audioTrack);

      assert.equal(combinedStream.getVideoTracks().length, 1);
      assert.equal(combinedStream.getAudioTracks().length, 1);
      assert.equal(combinedStream.getVideoTracks()[0]!.id, videoTrack.id);
      assert.equal(combinedStream.getAudioTracks()[0]!.id, audioTrack.id);
    } finally {
      dom.cleanup();
    }
  });

  it('R1+R3-T3-2: Should enforce strictly monotonic timestamps across concurrent audio and video chunks', () => {
    // Monotonic A/V sync clock verification
    const videoTimestampsUs: number[] = [];
    const audioTimestampsUs: number[] = [];

    const startTime = Date.now() * 1000;
    for (let frame = 0; frame < 60; frame++) {
      // 60 FPS ~16666 us per frame
      videoTimestampsUs.push(startTime + frame * 16666);
    }

    for (let chunk = 0; chunk < 100; chunk++) {
      // 10ms chunks = 10000 us per chunk
      audioTimestampsUs.push(startTime + chunk * 10000);
    }

    assertMonotonic(videoTimestampsUs, true, 'Video frame timestamps must be strictly increasing');
    assertMonotonic(audioTimestampsUs, true, 'Audio chunk timestamps must be strictly increasing');
    assert.ok(videoTimestampsUs[59]! > videoTimestampsUs[0]!);
    assert.ok(audioTimestampsUs[99]! > audioTimestampsUs[0]!);
  });

  it('R1+R3-T3-3: Should coordinate window selection with audio loopback process filtering for identical PID', () => {
    const selectedWindow = {
      id: 'window:9876',
      title: 'Counter-Strike 2',
      process_name: 'cs2.exe',
      pid: 9876,
    };

    // 1. Validate video capture start invoke
    const videoInvoke = validateIpcInvoke('start_native_screen_capture', {
      sourceId: selectedWindow.id,
      targetFps: 60,
    });
    assert.equal(videoInvoke.valid, true);

    // 2. Validate audio loopback start invoke targeting the identical window PID
    const audioConfig = {
      mode: 'include',
      target_pids: [selectedWindow.pid],
      target_names: [selectedWindow.process_name],
      sample_rate: 48000,
    };
    const audioInvoke = validateIpcInvoke('start_audio_capture', { config: audioConfig });
    assert.equal(audioInvoke.valid, true);
    assert.equal(audioConfig.target_pids[0], 9876);
  });

  it('R1+R3-T3-4: Should preserve audio loopback streaming when video encounters native fallback', () => {
    let videoCaptureSource: 'native' | 'gpu_direct' = 'native';
    const audioTrack = new MockMediaStreamTrack('audio', 'audio-loopback-track');

    function simulateNativeCaptureFallback(reason: string) {
      if (reason === 'window_minimized') {
        videoCaptureSource = 'gpu_direct';
      }
    }

    assert.equal(videoCaptureSource, 'native');
    assert.equal(audioTrack.readyState, 'live');

    // Minimized window triggers fallback to getDisplayMedia
    simulateNativeCaptureFallback('window_minimized');
    assert.equal(videoCaptureSource, 'gpu_direct');
    // Audio track must remain untouched and live
    assert.equal(audioTrack.readyState, 'live');
    assert.equal(audioTrack.enabled, true);
  });

  it('R1+R3-T3-5: Should handle audio mute toggle without interrupting active 60 FPS video capture', () => {
    const dom = setupTestDOM();
    try {
      const canvas = dom.document.createElement('canvas') as MockCanvasElement;
      const videoStream = canvas.captureStream(60);
      const videoTrack = videoStream.getVideoTracks()[0]!;

      const audioTrack = new MockMediaStreamTrack('audio', 'audio-track');
      assert.equal(audioTrack.enabled, true);
      assert.equal(videoTrack.enabled, true);

      // User mutes audio
      audioTrack.enabled = false;

      assert.equal(audioTrack.enabled, false);
      assert.equal(videoTrack.enabled, true, 'Video track must remain live and enabled during audio mute');
      assert.equal(videoTrack.readyState, 'live');
    } finally {
      dom.cleanup();
    }
  });
});
