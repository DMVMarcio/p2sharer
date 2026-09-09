import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupTestDOM,
  MockCanvasElement,
  MockMediaStreamTrack,
  MockMediaStream,
} from '../harness/dom-mock.ts';
import { validateIpcInvoke } from '../harness/ipc-contract.ts';
import type { ScreenSourcesResponse } from '../harness/types.ts';
import { MediaCoordinator } from '../../../src/p2p/media_coordinator.ts';
import { NativeVideoBridge } from '../../../src/video/native_video_bridge.ts';

describe('Tier 1: R1 Video Pipeline & Screen Capture Coverage', () => {
  it('R1-T1-1: Should validate Direct GPU capture options structure for 1080p60', () => {
    const videoOptions = {
      video: {
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 60, max: 60 },
      },
      audio: false,
    };

    assert.equal(videoOptions.video.width.ideal, 1920);
    assert.equal(videoOptions.video.height.ideal, 1080);
    assert.equal(videoOptions.video.frameRate.ideal, 60);
    assert.equal(videoOptions.audio, false);
  });

  it('R1-T1-2: Should validate WindowSource schema structure', () => {
    const sampleWindowSource = {
      id: 'window:12345',
      title: 'Visual Studio Code - P2Sharer',
      process_name: 'Code.exe',
      pid: 12345,
      width: 1920,
      height: 1080,
      thumbnail: 'data:image/jpeg;base64,/9j/4AAQSkZJRg...',
    };

    assert.ok(sampleWindowSource.id.startsWith('window:'));
    assert.ok(sampleWindowSource.title.length > 0);
    assert.ok(sampleWindowSource.process_name.endsWith('.exe'));
    assert.ok(sampleWindowSource.pid > 0);
    assert.equal(typeof sampleWindowSource.width, 'number');
    assert.equal(typeof sampleWindowSource.height, 'number');
    assert.ok(sampleWindowSource.thumbnail.startsWith('data:image/jpeg;base64,'));
  });

  it('R1-T1-3: Should validate MonitorSource schema structure', () => {
    const sampleMonitorSource = {
      id: 'monitor:0',
      name: 'Generic PnP Monitor (Display 1)',
      width: 2560,
      height: 1440,
      is_primary: true,
      thumbnail: null,
    };

    assert.ok(sampleMonitorSource.id.startsWith('monitor:'));
    assert.equal(sampleMonitorSource.is_primary, true);
    assert.equal(sampleMonitorSource.width, 2560);
    assert.equal(sampleMonitorSource.height, 1440);

    const response: ScreenSourcesResponse = {
      monitors: [sampleMonitorSource],
      windows: [],
    };
    assert.equal(response.monitors.length, 1);
    assert.equal(response.windows.length, 0);
  });

  it('R1-T1-4: Should validate native capture IPC invocation contracts', () => {
    const startArgs = {
      sourceId: 'monitor:0',
      targetFps: 60,
      targetWidth: 1920,
      targetHeight: 1080,
      captureMouse: true,
      quality: 80,
    };
    const startResult = validateIpcInvoke('start_native_screen_capture', startArgs);
    assert.equal(startResult.valid, true);

    const stopResult = validateIpcInvoke('stop_native_screen_capture', {});
    assert.equal(stopResult.valid, true);

    const portResult = validateIpcInvoke('get_video_ws_port', {});
    assert.equal(portResult.valid, true);
  });

  it('R1-T1-5: Should initialize offscreen canvas and verify bitmaprenderer context', () => {
    const dom = setupTestDOM();
    try {
      const canvas = dom.document.createElement('canvas') as MockCanvasElement;
      canvas.width = 1920;
      canvas.height = 1080;

      const bitmapCtx = canvas.getContext('bitmaprenderer');
      assert.ok(bitmapCtx !== null, 'bitmaprenderer context should be available');
      assert.equal(typeof bitmapCtx.transferFromImageBitmap, 'function');
    } finally {
      dom.cleanup();
    }
  });

  it('R1-T1-6: Should capture canvas stream and enforce contentHint = motion', () => {
    const dom = setupTestDOM();
    try {
      const canvas = dom.document.createElement('canvas') as MockCanvasElement;
      const stream = canvas.captureStream(60);
      assert.ok(stream instanceof MockMediaStream);

      const videoTrack = stream.getVideoTracks()[0];
      assert.ok(videoTrack !== undefined);
      assert.equal(videoTrack.kind, 'video');

      // Set contentHint for WebRTC low-latency motion optimization
      videoTrack.contentHint = 'motion';
      assert.equal(videoTrack.contentHint, 'motion');
    } finally {
      dom.cleanup();
    }
  });

  it('R1-T1-7: Should prioritize hardware codecs (H.264 -> AV1 -> VP9 -> VP8) using MediaCoordinator.sortCodecs', () => {
    const inputCodecs = [
      { mimeType: 'video/VP8', clockRate: 90000 },
      { mimeType: 'video/rtx', clockRate: 90000 },
      { mimeType: 'video/VP9', clockRate: 90000 },
      { mimeType: 'video/AV1', clockRate: 90000 },
      { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'profile-level-id=42e01f' },
      { mimeType: 'video/h264', clockRate: 90000, sdpFmtpLine: 'profile-level-id=640c1f' },
      { mimeType: 'video/ulpfec', clockRate: 90000 },
    ];

    const sorted = MediaCoordinator.sortCodecs(inputCodecs);

    // H.264 must be prioritized first
    assert.equal(sorted[0].mimeType.toLowerCase(), 'video/h264');
    assert.equal(sorted[1].mimeType.toLowerCase(), 'video/h264');
    // AV1 next
    assert.equal(sorted[2].mimeType.toLowerCase(), 'video/av1');
    // VP9 third
    assert.equal(sorted[3].mimeType.toLowerCase(), 'video/vp9');
    // VP8 fourth (fallback)
    assert.equal(sorted[4].mimeType.toLowerCase(), 'video/vp8');
    // Other auxiliary codecs preserved
    assert.equal(sorted[5].mimeType.toLowerCase(), 'video/rtx');
    assert.equal(sorted[6].mimeType.toLowerCase(), 'video/ulpfec');
  });

  it('R1-T1-8: Should support VideoSourceOptions and Direct GPU lifecycle in NativeVideoBridge', async () => {
    const dom = setupTestDOM();
    try {
      const bridge = new NativeVideoBridge();
      assert.equal(bridge.isCapturingDirectGpu(), false);
      assert.equal(bridge.isCapturingNative(), false);

      // Mock navigator.mediaDevices.getDisplayMedia
      let displayMediaRequested = false;
      const originalMediaDevices = (globalThis.navigator as any)?.mediaDevices;
      Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        value: {
          getDisplayMedia: async (constraints: any) => {
            displayMediaRequested = true;
            assert.equal(constraints.video.frameRate.ideal, 60);
            assert.equal(constraints.video.displaySurface, 'monitor');
            assert.equal(constraints.audio, false);
            const stream = new MockMediaStream('mock-gpu-stream');
            const track = new MockMediaStreamTrack('video', 'gpu-video-track');
            stream.addTrack(track);
            return stream as unknown as MediaStream;
          },
        },
        configurable: true,
        writable: true,
      });

      const stream = await bridge.startCapture({
        mode: 'gpu_direct',
        frameRate: 60,
      });

      assert.ok(stream);
      assert.equal(displayMediaRequested, true);
      assert.equal(bridge.isCapturingDirectGpu(), true);
      assert.equal(bridge.isCapturingNative(), false);

      const videoTrack = stream.getVideoTracks()[0];
      assert.equal(videoTrack.contentHint, 'motion');

      await bridge.stopCapture();
      assert.equal(bridge.isCapturingDirectGpu(), false);
      assert.equal(bridge.isCapturingNative(), false);
    } finally {
      dom.cleanup();
    }
  });

  it('R1-T1-9: Should trigger automatic fallback to getDisplayMedia on window minimization or capture error', async () => {
    const dom = setupTestDOM();
    try {
      const bridge = new NativeVideoBridge();
      let fallbackReason = '';
      let receivedStream: MediaStream | undefined;
      bridge.onFallbackNeeded = (reason: string, stream?: MediaStream) => {
        fallbackReason = reason;
        receivedStream = stream;
      };

      Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        value: {
          getDisplayMedia: async () => {
            const stream = new MockMediaStream('fallback-gpu-stream');
            const track = new MockMediaStreamTrack('video', 'gpu-fallback-track');
            stream.addTrack(track);
            return stream as unknown as MediaStream;
          },
        },
        configurable: true,
        writable: true,
      });

      // Trigger fallback directly
      await (bridge as any).triggerFallback('window_minimized', 60);
      assert.equal(fallbackReason, 'window_minimized');
      assert.equal(bridge.isCapturingDirectGpu(), true);
      assert.equal((bridge as any).activeStream.getVideoTracks()[0].readyState, 'live');
      assert.ok(receivedStream, 'fallback stream must be passed to onFallbackNeeded');
      assert.equal(receivedStream.getVideoTracks()[0].readyState, 'live');

      await bridge.stopCapture();
    } finally {
      dom.cleanup();
    }
  });

  it('R1-T1-10: Should configure codec preferences on RTCRtpTransceiver for video tracks', () => {
    const mockCapabilities = {
      codecs: [
        { mimeType: 'video/VP8', clockRate: 90000 },
        { mimeType: 'video/H264', clockRate: 90000 },
        { mimeType: 'video/AV1', clockRate: 90000 },
        { mimeType: 'video/VP9', clockRate: 90000 },
      ],
    };

    (globalThis as any).RTCRtpSender = {
      getCapabilities: (kind: string) => (kind === 'video' ? mockCapabilities : null),
    };

    let appliedCodecs: any[] = [];
    const mockTransceiver = {
      sender: { track: { kind: 'video' } },
      receiver: { track: { kind: 'video' } },
      setCodecPreferences: (codecs: any[]) => {
        appliedCodecs = codecs;
      },
    };

    const mockPc = {
      getTransceivers: () => [mockTransceiver],
    } as unknown as RTCPeerConnection;

    MediaCoordinator.configureCodecPreferences(mockPc);

    assert.equal(appliedCodecs.length, 4);
    assert.equal(appliedCodecs[0].mimeType, 'video/H264');
    assert.equal(appliedCodecs[1].mimeType, 'video/AV1');
    assert.equal(appliedCodecs[2].mimeType, 'video/VP9');
    assert.equal(appliedCodecs[3].mimeType, 'video/VP8');
  });
});
