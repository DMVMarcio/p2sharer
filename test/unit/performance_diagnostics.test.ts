import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzePerformanceReport,
  formatPerformanceLogs,
  type FrontendPerformanceReport,
  type NativePerformanceReport,
} from '../../src/services/performance_diagnostics.ts';

function makeFrontend(overrides: Partial<FrontendPerformanceReport> = {}): FrontendPerformanceReport {
  return {
    hardwareAcceleration: true,
    webglVendor: 'NVIDIA Corporation',
    webglRenderer: 'ANGLE (NVIDIA GeForce GTX 660)',
    devicePixelRatio: 1,
    viewport: { width: 1280, height: 720 },
    screen: { width: 1920, height: 1080 },
    hardwareConcurrency: 4,
    visibilityState: 'visible',
    uiFrames: {
      count: 600,
      avgFps: 60,
      avgFrameMs: 16.6,
      p95FrameMs: 18.2,
      maxFrameMs: 22.1,
      jankyFramesOver20ms: 2,
      jankyFramesOver33ms: 0,
      jankyFramesOver50ms: 0,
    },
    eventLoop: {
      sampleCount: 50,
      avgLagMs: 1.2,
      maxLagMs: 8.4,
      stallsOver50ms: 0,
    },
    longTasks: {
      supported: true,
      count: 0,
      totalBlockingMs: 0,
      maxTaskMs: 0,
    },
    stateStore: {
      notificationsTotal: 12,
      notificationsPerSec: 1.2,
    },
    dom: {
      totalNodes: 850,
      videoElements: 1,
      canvasElements: 0,
      svgElements: 20,
      activeCssAnimations: 2,
      videos: [],
    },
    jsHeap: { usedMb: 42, totalMb: 64, limitMb: 2048 },
    context: {
      inRoom: true,
      peerCount: 3,
      directPeerCount: 2,
      layoutMode: 'grid',
      inVoice: true,
      voiceMicMuted: false,
      voiceDeafened: false,
      voicePeerCount: 2,
      localCaptureCount: 1,
      localCaptureKinds: ['screen'],
      subscribedStreamCount: 1,
      activePipCount: 0,
      roomAppCount: 0,
      roomAppKinds: [],
      animationsEnabled: true,
      visualEffectsEnabled: true,
      themeMode: 'dark',
      encoderPreference: 'auto',
      defaultResolution: '1280x720',
      defaultFps: 30,
      defaultBitrate: 3000,
    },
    webrtc: {
      connectionCount: 1,
      connections: [],
    },
    ...overrides,
  };
}

function makeNative(overrides: Partial<NativePerformanceReport['summary']> = {}): NativePerformanceReport {
  return {
    schema: 1,
    session_id: 123,
    started_epoch_ms: 1000,
    finished_epoch_ms: 11000,
    hardware: {
      app_version: '1.8.4',
      build_mode: 'release',
      arch: 'x86_64',
      os_name: 'Windows',
      os_version: '10',
      cpu_brand: 'Intel Core2 Quad Q6600',
      cpu_logical_cores: 4,
      cpu_physical_cores: 4,
      cpu_frequency_mhz: 3000,
      total_ram_mb: 8192,
      available_ram_mb: 3200,
      used_ram_mb: 4992,
      gpu_adapters: [
        {
          description: 'NVIDIA GeForce GTX 660',
          vendor_id: 0x10de,
          device_id: 0x11c0,
          dedicated_vram_mb: 2048,
          shared_memory_mb: 4096,
          is_software: false,
        },
      ],
      native_nvenc_available: true,
      native_encoder_note: 'NVENC driver API available',
    },
    summary: {
      duration_ms: 10000,
      p2sharer_avg_cpu_pct: 3.5,
      p2sharer_peak_cpu_pct: 5.0,
      p2sharer_cpu_ms_per_sec: 140,
      p2sharer_user_ms: 1000,
      p2sharer_kernel_ms: 400,
      p2sharer_working_set_mb: 95,
      p2sharer_private_mb: 72,
      webview2_avg_cpu_pct: 4.5,
      webview2_peak_cpu_pct: 7.0,
      webview2_cpu_ms_per_sec: 180,
      webview2_user_ms: 1400,
      webview2_kernel_ms: 400,
      webview2_working_set_mb: 240,
      webview2_private_mb: 210,
      combined_avg_cpu_pct: 8.0,
      combined_peak_cpu_pct: 12.0,
      system_avg_cpu_pct: 18.0,
      system_peak_cpu_pct: 25.0,
      webview2_process_count: 5,
      p2sharer_thread_count: 24,
      active_capture_count: 1,
      audio_capture_active: true,
      ...overrides,
    },
    webview2_by_role: [
      {
        role: 'webview2-renderer',
        process_count: 1,
        cpu_pct_total: 2.5,
        cpu_pct_single_core: 10,
        cpu_ms_per_sec: 100,
        user_ms: 800,
        kernel_ms: 200,
        working_set_mb: 120,
        private_mb: 110,
      },
      {
        role: 'webview2-gpu',
        process_count: 1,
        cpu_pct_total: 1.5,
        cpu_pct_single_core: 6,
        cpu_ms_per_sec: 60,
        user_ms: 400,
        kernel_ms: 200,
        working_set_mb: 80,
        private_mb: 70,
      },
    ],
    processes: [],
    top_threads: [
      {
        tid: 42,
        name: 'wgc-capture',
        cpu_pct_total: 2.0,
        cpu_pct_single_core: 8.0,
        total_cpu_ms: 800,
        user_ms: 600,
        kernel_ms: 200,
      },
    ],
    capture_sessions: [],
    timeline: [],
  };
}

test('identifies optimal performance when CPU and FPS are healthy', () => {
  const analysis = analyzePerformanceReport(makeNative(), makeFrontend());
  assert.equal(analysis.severity, 'optimal');
  assert.equal(analysis.primaryBottleneck, 'balanced');
});

test('flags software rendering when hardware acceleration is unavailable', () => {
  const analysis = analyzePerformanceReport(
    makeNative({ combined_avg_cpu_pct: 25, webview2_avg_cpu_pct: 22 }),
    makeFrontend({ hardwareAcceleration: false }),
  );
  assert.equal(analysis.primaryBottleneck, 'software-rendering');
  assert.ok(analysis.findings.some((f) => f.includes('software rendering')));
});

test('flags native bottleneck when p2sharer.exe dominates high CPU usage', () => {
  const analysis = analyzePerformanceReport(
    makeNative({ p2sharer_avg_cpu_pct: 26, webview2_avg_cpu_pct: 12, combined_avg_cpu_pct: 38 }),
    makeFrontend(),
  );
  assert.equal(analysis.severity, 'blocked');
  assert.equal(analysis.primaryBottleneck, 'native');
  assert.ok(analysis.findings.some((f) => f.includes('wgc-capture')));
});

test('formats detailed multi-section technical logs including hardware, roles, and threads', () => {
  const native = makeNative();
  const frontend = makeFrontend();
  const analysis = analyzePerformanceReport(native, frontend);
  const logs = formatPerformanceLogs({
    schema: 1,
    generatedAtIso: '2026-11-26T18:00:00.000Z',
    durationMs: 10000,
    native,
    frontend,
    analysis,
  });
  const text = logs.join('\n');
  assert.ok(text.includes('Intel Core2 Quad Q6600'));
  assert.ok(text.includes('NVIDIA GeForce GTX 660'));
  assert.ok(text.includes('webview2-renderer'));
  assert.ok(text.includes('wgc-capture'));
  assert.ok(text.includes('StateStore Churn'));
});
