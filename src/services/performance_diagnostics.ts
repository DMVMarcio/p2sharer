import { isTauri } from '@tauri-apps/api/core';
import { invoke } from '../platform/commands.ts';
import { stateStore } from '../core/state_store.ts';
import { detectHardwareAcceleration } from '../core/hardware_acceleration.ts';
import { getEncoderPreference } from '../core/encoder_preferences.ts';
import { roomService } from './room_service.ts';
import { roomAppsService } from '../apps/room_apps_service.ts';

export interface GpuAdapterInfo {
  description: string;
  vendor_id: number;
  device_id: number;
  dedicated_vram_mb: number;
  shared_memory_mb: number;
  is_software: boolean;
}

export interface HardwareInfo {
  app_version: string;
  build_mode: string;
  arch: string;
  os_name: string;
  os_version: string;
  cpu_brand: string;
  cpu_logical_cores: number;
  cpu_physical_cores: number;
  cpu_frequency_mhz: number;
  total_ram_mb: number;
  available_ram_mb: number;
  used_ram_mb: number;
  gpu_adapters: GpuAdapterInfo[];
  native_nvenc_available: boolean;
  native_encoder_note: string;
}

export interface PerfDiagTickSample {
  elapsed_ms: number;
  delta_ms: number;
  p2sharer_cpu_pct: number;
  webview2_cpu_pct: number;
  webview2_renderer_cpu_pct: number;
  webview2_gpu_cpu_pct: number;
  combined_cpu_pct: number;
  system_cpu_pct: number;
  p2sharer_working_set_mb: number;
  webview2_working_set_mb: number;
  webview2_process_count: number;
  active_capture_count: number;
  audio_capture_active: boolean;
}

export interface ProcessCpuBreakdown {
  pid: number;
  exe_name: string;
  role: string;
  cpu_pct_total: number;
  cpu_pct_single_core: number;
  cpu_ms_per_sec: number;
  user_ms: number;
  kernel_ms: number;
  working_set_mb: number;
  private_mb: number;
}

export interface RoleCpuBreakdown {
  role: string;
  process_count: number;
  cpu_pct_total: number;
  cpu_pct_single_core: number;
  cpu_ms_per_sec: number;
  user_ms: number;
  kernel_ms: number;
  working_set_mb: number;
  private_mb: number;
}

export interface ThreadCpuBreakdown {
  tid: number;
  name: string;
  cpu_pct_total: number;
  cpu_pct_single_core: number;
  total_cpu_ms: number;
  user_ms: number;
  kernel_ms: number;
}

export interface CaptureSessionDelta {
  session_index: number;
  backend: string;
  encoder: string;
  delta_callbacks: number;
  delta_gated: number;
  delta_images: number;
  delta_nvenc_images: number;
  delta_gpu_scaled_images: number;
  callbacks_per_sec: number;
  images_per_sec: number;
  avg_readback_ms: number;
  avg_jpeg_ms: number;
  avg_nvenc_ms: number;
  avg_resize_ms: number;
  avg_processing_ms: number;
  delta_queue_drops: number;
  delta_missed_deadlines: number;
  delta_nvenc_fallbacks: number;
  delta_readback_errors: number;
  delta_jpeg_errors: number;
  max_queue_age_ms: number;
}

export interface NativePerfSummary {
  duration_ms: number;
  p2sharer_avg_cpu_pct: number;
  p2sharer_peak_cpu_pct: number;
  p2sharer_cpu_ms_per_sec: number;
  p2sharer_user_ms: number;
  p2sharer_kernel_ms: number;
  p2sharer_working_set_mb: number;
  p2sharer_private_mb: number;
  webview2_avg_cpu_pct: number;
  webview2_peak_cpu_pct: number;
  webview2_cpu_ms_per_sec: number;
  webview2_user_ms: number;
  webview2_kernel_ms: number;
  webview2_working_set_mb: number;
  webview2_private_mb: number;
  combined_avg_cpu_pct: number;
  combined_peak_cpu_pct: number;
  system_avg_cpu_pct: number;
  system_peak_cpu_pct: number;
  webview2_process_count: number;
  p2sharer_thread_count: number;
  active_capture_count: number;
  audio_capture_active: boolean;
}

export interface NativePerformanceReport {
  schema: number;
  session_id: number;
  started_epoch_ms: number;
  finished_epoch_ms: number;
  hardware: HardwareInfo;
  summary: NativePerfSummary;
  webview2_by_role: RoleCpuBreakdown[];
  processes: ProcessCpuBreakdown[];
  top_threads: ThreadCpuBreakdown[];
  capture_sessions: CaptureSessionDelta[];
  timeline: PerfDiagTickSample[];
}

export interface VideoElementPerfDelta {
  index: number;
  width: number;
  height: number;
  paused: boolean;
  muted: boolean;
  readyState: number;
  deltaFrames: number;
  deltaDroppedFrames: number;
  dropRatePct: number;
}

export interface WebRtcStreamPerfDelta {
  direction: 'outbound' | 'inbound';
  kind: 'video' | 'audio';
  codec: string | null;
  implementation: string | null;
  powerEfficient: boolean | null;
  qualityLimitationReason: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrateKbps: number;
  deltaFrames: number;
  deltaFramesDropped: number;
  avgCodecTimeMs: number | null;
  deltaPacketsLost: number;
  jitterMs: number | null;
}

export interface WebRtcConnectionPerfDelta {
  index: number;
  connectionState: string;
  iceConnectionState: string;
  rttMs: number | null;
  streams: WebRtcStreamPerfDelta[];
}

export interface FrontendPerformanceReport {
  hardwareAcceleration: boolean;
  webglVendor: string | null;
  webglRenderer: string | null;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  screen: { width: number; height: number };
  hardwareConcurrency: number;
  visibilityState: string;
  uiFrames: {
    count: number;
    avgFps: number;
    avgFrameMs: number;
    p95FrameMs: number;
    maxFrameMs: number;
    jankyFramesOver20ms: number;
    jankyFramesOver33ms: number;
    jankyFramesOver50ms: number;
  };
  eventLoop: {
    sampleCount: number;
    avgLagMs: number;
    maxLagMs: number;
    stallsOver50ms: number;
  };
  longTasks: {
    supported: boolean;
    count: number;
    totalBlockingMs: number;
    maxTaskMs: number;
  };
  stateStore: {
    notificationsTotal: number;
    notificationsPerSec: number;
  };
  dom: {
    totalNodes: number;
    videoElements: number;
    canvasElements: number;
    svgElements: number;
    activeCssAnimations: number;
    videos: VideoElementPerfDelta[];
  };
  jsHeap: {
    usedMb: number;
    totalMb: number;
    limitMb: number;
  } | null;
  context: {
    inRoom: boolean;
    peerCount: number;
    directPeerCount: number;
    layoutMode: string;
    inVoice: boolean;
    voiceMicMuted: boolean;
    voiceDeafened: boolean;
    voicePeerCount: number;
    localCaptureCount: number;
    localCaptureKinds: string[];
    subscribedStreamCount: number;
    activePipCount: number;
    roomAppCount: number;
    roomAppKinds: string[];
    animationsEnabled: boolean;
    visualEffectsEnabled: boolean;
    themeMode: string;
    encoderPreference: string;
    defaultResolution: string;
    defaultFps: number;
    defaultBitrate: number;
  };
  webrtc: {
    connectionCount: number;
    connections: WebRtcConnectionPerfDelta[];
  };
}

export type PerfSeverity = 'optimal' | 'moderate' | 'restricted' | 'blocked';
export type PerfBottleneck =
  | 'balanced'
  | 'native'
  | 'webview-renderer'
  | 'webview-gpu'
  | 'software-rendering'
  | 'webrtc-software';

export interface PerformanceAnalysis {
  severity: PerfSeverity;
  primaryBottleneck: PerfBottleneck;
  findings: string[];
}

export interface PerformanceDiagnosticProgress {
  elapsedMs: number;
  targetMs: number;
  latestTick: PerfDiagTickSample | null;
}

export interface PerformanceDiagnosticReport {
  schema: 1;
  generatedAtIso: string;
  durationMs: number;
  native: NativePerformanceReport | null;
  frontend: FrontendPerformanceReport;
  analysis: PerformanceAnalysis;
  logs: string[];
  rawJson: string;
}

function round2(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function probeWebGlInfo(): { vendor: string | null; renderer: string | null } {
  if (typeof document === 'undefined') return { vendor: null, renderer: null };
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return { vendor: null, renderer: null };
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || '') || null : null;
    const renderer = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '') || null : null;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { vendor, renderer };
  } catch {
    return { vendor: null, renderer: null };
  }
}

interface RawRtpEntry {
  key: string;
  direction: 'outbound' | 'inbound';
  kind: 'video' | 'audio';
  codec: string | null;
  implementation: string | null;
  powerEfficient: boolean | null;
  qualityLimitationReason: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bytes: number;
  frames: number;
  framesDropped: number;
  codecTimeSec: number;
  packetsLost: number;
  jitterMs: number | null;
}

interface RawConnSnapshot {
  pc: RTCPeerConnection;
  connectionState: string;
  iceConnectionState: string;
  rttMs: number | null;
  streams: Map<string, RawRtpEntry>;
}

async function captureWebRtcSnapshot(connections: RTCPeerConnection[]): Promise<RawConnSnapshot[]> {
  const results = await Promise.all(
    connections.slice(0, 32).map(async (pc): Promise<RawConnSnapshot> => {
      const streams = new Map<string, RawRtpEntry>();
      let rttMs: number | null = null;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const stats = await Promise.race([
          pc.getStats(),
          new Promise<null>((resolve) => {
            timeout = setTimeout(() => resolve(null), 900);
          }),
        ]);
        if (stats) {
          const codecs = new Map<string, string>();
          stats.forEach((s: Record<string, unknown>) => {
            if (s.type === 'codec' && typeof s.id === 'string' && typeof s.mimeType === 'string') {
              codecs.set(s.id, s.mimeType);
            }
            if (s.type === 'candidate-pair' && s.nominated && typeof s.currentRoundTripTime === 'number') {
              rttMs = round2(s.currentRoundTripTime * 1000);
            }
          });
          stats.forEach((s: Record<string, unknown>) => {
            if (s.type !== 'outbound-rtp' && s.type !== 'inbound-rtp') return;
            const kind = s.kind === 'audio' ? 'audio' : s.kind === 'video' ? 'video' : null;
            if (!kind) return;
            const direction = s.type === 'outbound-rtp' ? 'outbound' : 'inbound';
            const key = `${direction}:${kind}:${String(s.ssrc ?? s.id ?? '')}`;
            const codec = typeof s.codecId === 'string' ? codecs.get(s.codecId) ?? null : null;
            const implementation =
              direction === 'outbound'
                ? (typeof s.encoderImplementation === 'string' ? s.encoderImplementation : null)
                : (typeof s.decoderImplementation === 'string' ? s.decoderImplementation : null);
            const powerEfficient =
              direction === 'outbound'
                ? (typeof s.powerEfficientEncoder === 'boolean' ? s.powerEfficientEncoder : null)
                : (typeof s.powerEfficientDecoder === 'boolean' ? s.powerEfficientDecoder : null);
            const bytes =
              direction === 'outbound'
                ? (typeof s.bytesSent === 'number' ? s.bytesSent : 0)
                : (typeof s.bytesReceived === 'number' ? s.bytesReceived : 0);
            const frames =
              direction === 'outbound'
                ? (typeof s.framesEncoded === 'number' ? s.framesEncoded : 0)
                : (typeof s.framesDecoded === 'number' ? s.framesDecoded : 0);
            const codecTimeSec =
              direction === 'outbound'
                ? (typeof s.totalEncodeTime === 'number' ? s.totalEncodeTime : 0)
                : (typeof s.totalDecodeTime === 'number' ? s.totalDecodeTime : 0);
            streams.set(key, {
              key,
              direction,
              kind,
              codec,
              implementation,
              powerEfficient,
              qualityLimitationReason:
                typeof s.qualityLimitationReason === 'string' ? s.qualityLimitationReason : null,
              width: typeof s.frameWidth === 'number' ? s.frameWidth : null,
              height: typeof s.frameHeight === 'number' ? s.frameHeight : null,
              fps: typeof s.framesPerSecond === 'number' ? round2(s.framesPerSecond) : null,
              bytes,
              frames,
              framesDropped: typeof s.framesDropped === 'number' ? s.framesDropped : 0,
              codecTimeSec,
              packetsLost: typeof s.packetsLost === 'number' ? s.packetsLost : 0,
              jitterMs: typeof s.jitter === 'number' ? round2(s.jitter * 1000) : null,
            });
          });
        }
      } catch {
        // Ignore closed/transient peer stats errors.
      } finally {
        clearTimeout(timeout);
      }
      return {
        pc,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        rttMs,
        streams,
      };
    }),
  );
  return results;
}

function diffWebRtcSnapshots(
  base: RawConnSnapshot[],
  end: RawConnSnapshot[],
  durationSecs: number,
): WebRtcConnectionPerfDelta[] {
  const baseByPc = new Map<RTCPeerConnection, RawConnSnapshot>();
  for (const snap of base) baseByPc.set(snap.pc, snap);
  const secs = Math.max(durationSecs, 0.001);

  return end.map((cur, index) => {
    const prev = baseByPc.get(cur.pc);
    const streams: WebRtcStreamPerfDelta[] = [];
    cur.streams.forEach((entry, key) => {
      const prevEntry = prev?.streams.get(key);
      const dBytes = Math.max(0, entry.bytes - (prevEntry?.bytes ?? entry.bytes));
      const dFrames = Math.max(0, entry.frames - (prevEntry?.frames ?? entry.frames));
      const dDropped = Math.max(0, entry.framesDropped - (prevEntry?.framesDropped ?? entry.framesDropped));
      const dCodecTimeSec = Math.max(0, entry.codecTimeSec - (prevEntry?.codecTimeSec ?? entry.codecTimeSec));
      const dPacketsLost = Math.max(0, entry.packetsLost - (prevEntry?.packetsLost ?? entry.packetsLost));
      streams.push({
        direction: entry.direction,
        kind: entry.kind,
        codec: entry.codec,
        implementation: entry.implementation,
        powerEfficient: entry.powerEfficient,
        qualityLimitationReason: entry.qualityLimitationReason,
        width: entry.width,
        height: entry.height,
        fps: entry.fps,
        bitrateKbps: round2((dBytes * 8) / 1000 / secs),
        deltaFrames: dFrames,
        deltaFramesDropped: dDropped,
        avgCodecTimeMs: dFrames > 0 ? round2((dCodecTimeSec / dFrames) * 1000) : null,
        deltaPacketsLost: dPacketsLost,
        jitterMs: entry.jitterMs,
      });
    });
    return {
      index,
      connectionState: cur.connectionState,
      iceConnectionState: cur.iceConnectionState,
      rttMs: cur.rttMs,
      streams,
    };
  });
}

function snapshotVideos(): Map<HTMLVideoElement, { total: number; dropped: number }> {
  const map = new Map<HTMLVideoElement, { total: number; dropped: number }>();
  if (typeof document === 'undefined') return map;
  document.querySelectorAll('video').forEach((v) => {
    const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
    map.set(v, {
      total: q?.totalVideoFrames ?? 0,
      dropped: q?.droppedVideoFrames ?? 0,
    });
  });
  return map;
}

function collectRoomContext(): FrontendPerformanceReport['context'] {
  const activeApps = roomAppsService.getInstances();
  const localKinds = Array.from(roomService.localCaptures.values()).map((c) => c.kind);
  const directPeerCount = roomService.roomManager?.getActivePeerConnections?.().length ?? 0;
  return {
    inRoom: Boolean(stateStore.currentRoomCode),
    peerCount: roomService.peers.length,
    directPeerCount,
    layoutMode: stateStore.layoutMode,
    inVoice: roomService.inVoice,
    voiceMicMuted: roomService.voiceMicMuted,
    voiceDeafened: roomService.voiceDeafened,
    voicePeerCount: Object.values(roomService.voicePeers).filter((p) => p.inVoice).length,
    localCaptureCount: roomService.localCaptures.size,
    localCaptureKinds: localKinds,
    subscribedStreamCount: stateStore.subscribedStreams.size,
    activePipCount: stateStore.activePipPeers.size,
    roomAppCount: activeApps.length,
    roomAppKinds: activeApps.map((a) => a.kind),
    animationsEnabled: stateStore.animationsEnabled,
    visualEffectsEnabled: stateStore.visualEffectsEnabled,
    themeMode: stateStore.currentThemeMode,
    encoderPreference: getEncoderPreference(),
    defaultResolution: `${stateStore.currentResolution.width}x${stateStore.currentResolution.height}`,
    defaultFps: stateStore.currentFps,
    defaultBitrate: stateStore.currentBitrate,
  };
}

export function analyzePerformanceReport(
  native: NativePerformanceReport | null,
  frontend: FrontendPerformanceReport,
): PerformanceAnalysis {
  const findings: string[] = [];
  const combinedCpu = native?.summary.combined_avg_cpu_pct ?? 0;
  const p2Cpu = native?.summary.p2sharer_avg_cpu_pct ?? 0;
  const wvCpu = native?.summary.webview2_avg_cpu_pct ?? 0;
  const rendererCpu =
    native?.webview2_by_role.find((r) => r.role === 'webview2-renderer')?.cpu_pct_total ?? 0;
  const gpuCpu =
    native?.webview2_by_role.find((r) => r.role === 'webview2-gpu')?.cpu_pct_total ?? 0;

  let severity: PerfSeverity = 'optimal';
  if (combinedCpu >= 35 || frontend.uiFrames.avgFps < 25 || frontend.eventLoop.maxLagMs > 200) {
    severity = 'blocked';
  } else if (combinedCpu >= 20 || frontend.uiFrames.avgFps < 45 || frontend.longTasks.totalBlockingMs > 300) {
    severity = 'restricted';
  } else if (combinedCpu >= 10 || frontend.stateStore.notificationsPerSec > 20) {
    severity = 'moderate';
  }

  const hasSoftwareWebRtc = frontend.webrtc.connections.some((c) =>
    c.streams.some(
      (s) =>
        s.kind === 'video' &&
        (s.powerEfficient === false ||
          (s.implementation != null && /libvpx|openh264|ffmpeg|software/i.test(s.implementation))),
    ),
  );

  let primaryBottleneck: PerfBottleneck = 'balanced';
  if (!frontend.hardwareAcceleration) {
    primaryBottleneck = 'software-rendering';
    findings.push('WebView2 hardware acceleration is disabled or fell back to software rendering.');
  } else if (native && combinedCpu >= 12) {
    if (p2Cpu > wvCpu * 1.25) {
      primaryBottleneck = 'native';
      const topThread = native.top_threads[0];
      findings.push(
        `Native process (p2sharer.exe) accounts for ${p2Cpu}% avg CPU (${native.summary.p2sharer_cpu_ms_per_sec} ms/s)` +
          (topThread ? `; busiest thread: ${topThread.name} (${topThread.cpu_pct_single_core}% of 1 core).` : '.'),
      );
    } else if (gpuCpu > rendererCpu * 1.25 && gpuCpu >= 6) {
      primaryBottleneck = 'webview-gpu';
      findings.push(
        `WebView2 GPU process accounts for ${gpuCpu}% avg CPU (video decoding, CSS visual effects, or compositing).`,
      );
    } else if (hasSoftwareWebRtc && wvCpu >= 10) {
      primaryBottleneck = 'webrtc-software';
      findings.push('WebRTC video stream is using software encoding/decoding inside WebView2.');
    } else if (wvCpu >= 10) {
      primaryBottleneck = 'webview-renderer';
      findings.push(
        `WebView2 renderer accounts for ${rendererCpu}% avg CPU (JS execution, React updates, or Web Audio).`,
      );
    }
  }

  if (frontend.stateStore.notificationsPerSec > 15) {
    findings.push(
      `High StateStore churn: ${frontend.stateStore.notificationsPerSec} notifications/s (${frontend.stateStore.notificationsTotal} total).`,
    );
  }
  if (frontend.longTasks.count > 0) {
    findings.push(
      `Detected ${frontend.longTasks.count} main-thread Long Tasks totaling ${frontend.longTasks.totalBlockingMs} ms (max ${frontend.longTasks.maxTaskMs} ms).`,
    );
  }
  if (frontend.dom.activeCssAnimations > 8 && frontend.context.animationsEnabled) {
    findings.push(`${frontend.dom.activeCssAnimations} active CSS animations running during measurement.`);
  }
  if (native) {
    for (const cap of native.capture_sessions) {
      if (cap.delta_queue_drops > 0 || cap.delta_missed_deadlines > 0) {
        findings.push(
          `Capture session #${cap.session_index} (${cap.backend}/${cap.encoder}): ${cap.delta_queue_drops} queue drops, ${cap.delta_missed_deadlines} missed deadlines.`,
        );
      }
      if (cap.encoder.includes('JPEG') && cap.avg_jpeg_ms > 8) {
        findings.push(
          `Capture session #${cap.session_index} using CPU JPEG encoding (${cap.avg_jpeg_ms} ms/frame avg, readback ${cap.avg_readback_ms} ms/frame).`,
        );
      }
    }
  }
  if (findings.length === 0) {
    findings.push('No major CPU or frame-pacing bottlenecks detected during this sampling window.');
  }

  return { severity, primaryBottleneck, findings };
}

export function formatPerformanceLogs(
  report: Omit<PerformanceDiagnosticReport, 'logs' | 'rawJson'>,
): string[] {
  const lines: string[] = [];
  const { native, frontend, analysis } = report;

  lines.push(`=== P2Sharer Performance Diagnostic Report (schema ${report.schema}) ===`);
  lines.push(`Timestamp: ${report.generatedAtIso} | Duration: ${(report.durationMs / 1000).toFixed(2)}s`);
  lines.push(`Verdict: ${analysis.severity.toUpperCase()} | Primary focus: ${analysis.primaryBottleneck}`);
  for (const f of analysis.findings) {
    lines.push(`  * ${f}`);
  }
  lines.push('');

  if (native) {
    const hw = native.hardware;
    lines.push('--- Hardware & Runtime ---');
    lines.push(`App: v${hw.app_version} (${hw.build_mode}, ${hw.arch}) | OS: ${hw.os_name} ${hw.os_version}`);
    lines.push(
      `CPU: ${hw.cpu_brand} | ${hw.cpu_physical_cores}C/${hw.cpu_logical_cores}T @ ${hw.cpu_frequency_mhz} MHz`,
    );
    lines.push(`RAM: ${hw.used_ram_mb} MB used / ${hw.total_ram_mb} MB total (${hw.available_ram_mb} MB available)`);
    lines.push(`Native Encoder Probe: ${hw.native_encoder_note}`);
    for (const gpu of hw.gpu_adapters) {
      lines.push(
        `GPU: ${gpu.description} (VRAM ${gpu.dedicated_vram_mb} MB, shared ${gpu.shared_memory_mb} MB${gpu.is_software ? ', SOFTWARE' : ''})`,
      );
    }
    lines.push('');

    const s = native.summary;
    lines.push('--- Process CPU & Memory Summary ---');
    lines.push(
      `Combined App CPU: ${s.combined_avg_cpu_pct}% avg (peak ${s.combined_peak_cpu_pct}%) | Machine CPU: ${s.system_avg_cpu_pct}% avg (peak ${s.system_peak_cpu_pct}%)`,
    );
    lines.push(
      `p2sharer.exe: ${s.p2sharer_avg_cpu_pct}% avg (peak ${s.p2sharer_peak_cpu_pct}%, ${s.p2sharer_cpu_ms_per_sec} ms/s | user ${s.p2sharer_user_ms} ms, kernel ${s.p2sharer_kernel_ms} ms) | RAM ${s.p2sharer_working_set_mb} MB WS / ${s.p2sharer_private_mb} MB private | ${s.p2sharer_thread_count} threads`,
    );
    lines.push(
      `WebView2 (${s.webview2_process_count} procs): ${s.webview2_avg_cpu_pct}% avg (peak ${s.webview2_peak_cpu_pct}%, ${s.webview2_cpu_ms_per_sec} ms/s | user ${s.webview2_user_ms} ms, kernel ${s.webview2_kernel_ms} ms) | RAM ${s.webview2_working_set_mb} MB WS / ${s.webview2_private_mb} MB private`,
    );
    lines.push('');

    if (native.webview2_by_role.length > 0) {
      lines.push('--- WebView2 Breakdown by Role ---');
      for (const r of native.webview2_by_role) {
        lines.push(
          `  ${r.role} (x${r.process_count}): ${r.cpu_pct_total}% total (${r.cpu_pct_single_core}% 1-core, ${r.cpu_ms_per_sec} ms/s | u=${r.user_ms}ms k=${r.kernel_ms}ms) | RAM ${r.working_set_mb} MB`,
        );
      }
      lines.push('');
    }

    if (native.top_threads.length > 0) {
      lines.push('--- Top p2sharer.exe Threads (by CPU time) ---');
      for (const th of native.top_threads.slice(0, 12)) {
        if (th.total_cpu_ms <= 0.1) continue;
        lines.push(
          `  [TID ${th.tid}] ${th.name}: ${th.total_cpu_ms} ms (${th.cpu_pct_total}% total / ${th.cpu_pct_single_core}% 1-core | u=${th.user_ms}ms k=${th.kernel_ms}ms)`,
        );
      }
      lines.push('');
    }

    if (native.capture_sessions.length > 0) {
      lines.push('--- Native Capture Sessions (delta) ---');
      for (const c of native.capture_sessions) {
        lines.push(
          `  Session #${c.session_index} [${c.backend} / ${c.encoder}]: ${c.images_per_sec} img/s (${c.callbacks_per_sec} cb/s, gated=${c.delta_gated}) | proc=${c.avg_processing_ms}ms readback=${c.avg_readback_ms}ms resize=${c.avg_resize_ms}ms jpeg=${c.avg_jpeg_ms}ms nvenc=${c.avg_nvenc_ms}ms | drops=${c.delta_queue_drops} missed=${c.delta_missed_deadlines} maxQ=${c.max_queue_age_ms}ms`,
        );
      }
      lines.push('');
    }
  }

  lines.push('--- WebView2 Main Thread, UI & DOM ---');
  lines.push(
    `HW Acceleration: ${frontend.hardwareAcceleration ? 'YES' : 'NO (SOFTWARE)'} | WebGL: ${frontend.webglRenderer ?? 'unavailable'} | DPR: ${frontend.devicePixelRatio} | Viewport: ${frontend.viewport.width}x${frontend.viewport.height}`,
  );
  lines.push(
    `UI FPS: ${frontend.uiFrames.avgFps} avg (frame avg ${frontend.uiFrames.avgFrameMs}ms, p95 ${frontend.uiFrames.p95FrameMs}ms, max ${frontend.uiFrames.maxFrameMs}ms | >20ms=${frontend.uiFrames.jankyFramesOver20ms}, >33ms=${frontend.uiFrames.jankyFramesOver33ms}, >50ms=${frontend.uiFrames.jankyFramesOver50ms})`,
  );
  lines.push(
    `Event Loop Lag: avg ${frontend.eventLoop.avgLagMs}ms, max ${frontend.eventLoop.maxLagMs}ms (>50ms stalls=${frontend.eventLoop.stallsOver50ms})`,
  );
  lines.push(
    `Long Tasks: ${frontend.longTasks.supported ? `${frontend.longTasks.count} tasks, ${frontend.longTasks.totalBlockingMs}ms total, max ${frontend.longTasks.maxTaskMs}ms` : 'unsupported'}`,
  );
  lines.push(
    `StateStore Churn: ${frontend.stateStore.notificationsTotal} updates (${frontend.stateStore.notificationsPerSec}/s)`,
  );
  lines.push(
    `DOM: ${frontend.dom.totalNodes} nodes | videos=${frontend.dom.videoElements} canvases=${frontend.dom.canvasElements} svgs=${frontend.dom.svgElements} cssAnims=${frontend.dom.activeCssAnimations}` +
      (frontend.jsHeap ? ` | JS Heap: ${frontend.jsHeap.usedMb}/${frontend.jsHeap.totalMb} MB` : ''),
  );
  for (const v of frontend.dom.videos) {
    lines.push(
      `  <video #${v.index}>: ${v.width}x${v.height} ${v.paused ? 'paused' : 'playing'} | +${v.deltaFrames} frames, +${v.deltaDroppedFrames} dropped (${v.dropRatePct}%)`,
    );
  }
  lines.push('');

  const ctx = frontend.context;
  lines.push('--- Room & Settings Context ---');
  lines.push(
    `In Room: ${ctx.inRoom ? 'yes' : 'no'} | Peers: ${ctx.peerCount} (direct PCs: ${ctx.directPeerCount}) | Layout: ${ctx.layoutMode} | Voice: ${ctx.inVoice ? `active (${ctx.voicePeerCount} peers)` : 'off'} | Audio Loopback: ${native?.summary.audio_capture_active ? 'active' : 'off'}`,
  );
  lines.push(
    `Streams: local=${ctx.localCaptureCount} [${ctx.localCaptureKinds.join(',') || 'none'}] subscribed=${ctx.subscribedStreamCount} pip=${ctx.activePipCount} | Apps: ${ctx.roomAppCount} [${ctx.roomAppKinds.join(',') || 'none'}]`,
  );
  lines.push(
    `Settings: animations=${ctx.animationsEnabled} visualEffects=${ctx.visualEffectsEnabled} theme=${ctx.themeMode} encoder=${ctx.encoderPreference} defaults=${ctx.defaultResolution}@${ctx.defaultFps}fps/${ctx.defaultBitrate}kbps`,
  );

  if (frontend.webrtc.connections.length > 0) {
    lines.push('');
    lines.push(`--- WebRTC Connections (${frontend.webrtc.connectionCount}) ---`);
    for (const conn of frontend.webrtc.connections) {
      lines.push(
        `  PC #${conn.index}: state=${conn.connectionState} ice=${conn.iceConnectionState} rtt=${conn.rttMs ?? 'n/a'}ms`,
      );
      for (const st of conn.streams) {
        lines.push(
          `    ${st.direction} ${st.kind}: codec=${st.codec ?? 'n/a'} impl=${st.implementation ?? 'n/a'} hw=${st.powerEfficient ?? 'n/a'} ${st.width && st.height ? `${st.width}x${st.height}@${st.fps ?? '?'}fps` : ''} ${st.bitrateKbps}kbps` +
            (st.avgCodecTimeMs != null ? ` codecTime=${st.avgCodecTimeMs}ms/f` : '') +
            (st.qualityLimitationReason && st.qualityLimitationReason !== 'none'
              ? ` limit=${st.qualityLimitationReason}`
              : '') +
            (st.deltaFramesDropped > 0 ? ` dropped=${st.deltaFramesDropped}` : '') +
            (st.deltaPacketsLost > 0 ? ` lost=${st.deltaPacketsLost}` : ''),
        );
      }
    }
  }

  if (native && native.timeline.length > 0) {
    lines.push('');
    lines.push('--- Per-Second Timeline ---');
    for (const t of native.timeline) {
      lines.push(
        `  t=${(t.elapsed_ms / 1000).toFixed(1)}s | total=${t.combined_cpu_pct}% (p2=${t.p2sharer_cpu_pct}%, wv2=${t.webview2_cpu_pct}% [ren=${t.webview2_renderer_cpu_pct}%, gpu=${t.webview2_gpu_cpu_pct}%]) | sys=${t.system_cpu_pct}% | RAM p2=${t.p2sharer_working_set_mb}MB wv2=${t.webview2_working_set_mb}MB`,
      );
    }
  }

  return lines;
}

export interface RunPerformanceDiagnosticOptions {
  durationMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: PerformanceDiagnosticProgress) => void;
}

export async function runPerformanceDiagnostics(
  options: RunPerformanceDiagnosticOptions = {},
): Promise<PerformanceDiagnosticReport> {
  const targetMs = Math.max(3000, Math.min(options.durationMs ?? 10000, 60000));
  const nativeEnabled = isTauri();
  const startedAt = performance.now();

  if (nativeEnabled) {
    await invoke('perf_diag_start');
  }

  // Baseline WebRTC & video elements
  const activePcs = roomService.roomManager?.getActivePeerConnections?.() ?? [];
  const baseWebRtc = await captureWebRtcSnapshot(activePcs);
  const baseVideos = snapshotVideos();

  // Frontend live observers (attached ONLY during measurement)
  let stateNotifications = 0;
  const unsubStore = stateStore.subscribe(() => {
    stateNotifications += 1;
  });

  const frameDeltas: number[] = [];
  let rafId = 0;
  let lastFrameAt = performance.now();
  let stopped = false;
  const onFrame = (now: number) => {
    if (stopped) return;
    const delta = now - lastFrameAt;
    lastFrameAt = now;
    if (delta > 0 && delta < 10_000) {
      frameDeltas.push(delta);
    }
    rafId = window.requestAnimationFrame(onFrame);
  };
  rafId = window.requestAnimationFrame(onFrame);

  const eventLoopLags: number[] = [];
  let lastLagCheck = performance.now();
  const lagTimer = window.setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - lastLagCheck - 200);
    lastLagCheck = now;
    eventLoopLags.push(lag);
  }, 200);

  let longTaskSupported = false;
  let longTaskCount = 0;
  let longTaskTotalMs = 0;
  let longTaskMaxMs = 0;
  let longTaskObserver: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskCount += 1;
          longTaskTotalMs += entry.duration;
          if (entry.duration > longTaskMaxMs) longTaskMaxMs = entry.duration;
        }
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
      longTaskSupported = true;
    } catch {
      longTaskObserver = null;
    }
  }

  const cleanup = () => {
    stopped = true;
    window.cancelAnimationFrame(rafId);
    window.clearInterval(lagTimer);
    unsubStore();
    try {
      longTaskObserver?.disconnect();
    } catch {
      // ignore
    }
  };

  try {
    // Sample every 1000ms until targetMs or abort
    while (performance.now() - startedAt < targetMs) {
      if (options.signal?.aborted) break;
      const remaining = targetMs - (performance.now() - startedAt);
      const waitMs = Math.min(1000, Math.max(100, remaining));
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, waitMs);
        const onAbort = () => {
          window.clearTimeout(timer);
          resolve();
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
      });
      if (options.signal?.aborted) break;

      let tick: PerfDiagTickSample | null = null;
      if (nativeEnabled) {
        try {
          tick = await invoke<PerfDiagTickSample>('perf_diag_sample');
        } catch {
          tick = null;
        }
      }
      options.onProgress?.({
        elapsedMs: Math.min(targetMs, Math.round(performance.now() - startedAt)),
        targetMs,
        latestTick: tick,
      });
    }

    cleanup();

    const actualDurationMs = Math.max(1, Math.round(performance.now() - startedAt));
    const durationSecs = actualDurationMs / 1000;

    let nativeReport: NativePerformanceReport | null = null;
    if (nativeEnabled) {
      nativeReport = await invoke<NativePerformanceReport>('perf_diag_finish');
    }

    const endPcs = roomService.roomManager?.getActivePeerConnections?.() ?? [];
    const endWebRtc = await captureWebRtcSnapshot(endPcs);
    const webrtcConnections = diffWebRtcSnapshots(baseWebRtc, endWebRtc, durationSecs);

    const endVideos = snapshotVideos();
    const videos: VideoElementPerfDelta[] = [];
    let vIdx = 0;
    endVideos.forEach((cur, el) => {
      const prev = baseVideos.get(el);
      const deltaFrames = Math.max(0, cur.total - (prev?.total ?? cur.total));
      const deltaDropped = Math.max(0, cur.dropped - (prev?.dropped ?? cur.dropped));
      videos.push({
        index: vIdx++,
        width: el.videoWidth,
        height: el.videoHeight,
        paused: el.paused,
        muted: el.muted,
        readyState: el.readyState,
        deltaFrames,
        deltaDroppedFrames: deltaDropped,
        dropRatePct: deltaFrames > 0 ? round2((deltaDropped / deltaFrames) * 100) : 0,
      });
    });

    const sortedFrames = [...frameDeltas].sort((a, b) => a - b);
    const frameCount = frameDeltas.length;
    const avgFrameMs = frameCount > 0 ? frameDeltas.reduce((a, b) => a + b, 0) / frameCount : 0;
    const p95FrameMs =
      sortedFrames.length > 0 ? sortedFrames[Math.min(sortedFrames.length - 1, Math.floor(sortedFrames.length * 0.95))] : 0;
    const maxFrameMs = sortedFrames.length > 0 ? sortedFrames[sortedFrames.length - 1] : 0;
    const avgFps = avgFrameMs > 0 ? 1000 / avgFrameMs : 0;

    const avgLagMs =
      eventLoopLags.length > 0 ? eventLoopLags.reduce((a, b) => a + b, 0) / eventLoopLags.length : 0;
    const maxLagMs = eventLoopLags.length > 0 ? Math.max(...eventLoopLags) : 0;
    const stallsOver50ms = eventLoopLags.filter((l) => l > 50).length;

    const perfWithMem = performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    };
    const jsHeap = perfWithMem.memory
      ? {
          usedMb: round2(perfWithMem.memory.usedJSHeapSize / (1024 * 1024)),
          totalMb: round2(perfWithMem.memory.totalJSHeapSize / (1024 * 1024)),
          limitMb: round2(perfWithMem.memory.jsHeapSizeLimit / (1024 * 1024)),
        }
      : null;

    const webgl = probeWebGlInfo();
    const hardwareAcceleration = detectHardwareAcceleration();
    const activeCssAnimations =
      typeof document.getAnimations === 'function'
        ? document.getAnimations().filter((a) => a.playState === 'running').length
        : 0;

    const frontend: FrontendPerformanceReport = {
      hardwareAcceleration,
      webglVendor: webgl.vendor,
      webglRenderer: webgl.renderer,
      devicePixelRatio: round2(window.devicePixelRatio || 1),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      screen: { width: window.screen.width, height: window.screen.height },
      hardwareConcurrency: navigator.hardwareConcurrency || 1,
      visibilityState: document.visibilityState,
      uiFrames: {
        count: frameCount,
        avgFps: round2(avgFps),
        avgFrameMs: round2(avgFrameMs),
        p95FrameMs: round2(p95FrameMs),
        maxFrameMs: round2(maxFrameMs),
        jankyFramesOver20ms: frameDeltas.filter((d) => d > 20).length,
        jankyFramesOver33ms: frameDeltas.filter((d) => d > 33.4).length,
        jankyFramesOver50ms: frameDeltas.filter((d) => d > 50).length,
      },
      eventLoop: {
        sampleCount: eventLoopLags.length,
        avgLagMs: round2(avgLagMs),
        maxLagMs: round2(maxLagMs),
        stallsOver50ms,
      },
      longTasks: {
        supported: longTaskSupported,
        count: longTaskCount,
        totalBlockingMs: round2(longTaskTotalMs),
        maxTaskMs: round2(longTaskMaxMs),
      },
      stateStore: {
        notificationsTotal: stateNotifications,
        notificationsPerSec: round2(stateNotifications / durationSecs),
      },
      dom: {
        totalNodes: document.getElementsByTagName('*').length,
        videoElements: document.querySelectorAll('video').length,
        canvasElements: document.querySelectorAll('canvas').length,
        svgElements: document.querySelectorAll('svg').length,
        activeCssAnimations,
        videos,
      },
      jsHeap,
      context: collectRoomContext(),
      webrtc: {
        connectionCount: webrtcConnections.length,
        connections: webrtcConnections,
      },
    };

    const analysis = analyzePerformanceReport(nativeReport, frontend);
    const baseReport = {
      schema: 1 as const,
      generatedAtIso: new Date().toISOString(),
      durationMs: nativeReport?.summary.duration_ms ?? actualDurationMs,
      native: nativeReport,
      frontend,
      analysis,
    };
    const logs = formatPerformanceLogs(baseReport);
    const rawJson = JSON.stringify({ ...baseReport, logs }, null, 2);

    // Best-effort save to logs folder on desktop so it is always accessible from Diagnostics > Open log folder
    if (nativeEnabled) {
      void invoke('save_performance_report_to_logs', { reportJson: rawJson }).catch(() => {});
    }

    return {
      ...baseReport,
      logs,
      rawJson,
    };
  } catch (err) {
    cleanup();
    if (nativeEnabled) {
      void invoke('perf_diag_cancel').catch(() => {});
    }
    throw err;
  }
}

export async function exportPerformanceReportFile(report: PerformanceDiagnosticReport): Promise<string | null> {
  const stamp = report.generatedAtIso.replace(/[:.]/g, '-').slice(0, 19);
  const suggestedName = `p2sharer-performance-${stamp}.json`;
  if (isTauri()) {
    return invoke<string | null>('export_performance_report', {
      reportJson: report.rawJson,
      suggestedName,
    });
  }
  // Browser fallback download
  const blob = new Blob([report.rawJson], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
  return suggestedName;
}
