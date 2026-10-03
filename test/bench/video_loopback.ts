import { resolveCaptureSource } from './capture_source';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { NativeVideoBridge } from '../../src/video/native_video_bridge';
import { MediaCoordinator } from '../../src/p2p/media_coordinator';
export { runNvencLifecycle, runNvencVisualCheck } from './nvenc_lifecycle';

/** Run inside the desktop WebView2 to exercise native capture and real RTP encoding. */
export async function runVideoLoopback(options: {
  sourceId?: string;
  peers?: number;
  pipeline?: 'native' | 'canvas';
  probe?: boolean;
  hideReceivers?: boolean;
  resolution?: { width: number; height: number };
  fps?: number;
  loadScenario?: boolean | 'sustained';
  warmupMs?: number;
} = {}) {
  const sourceId = options.pipeline === 'canvas' ? '' : await resolveCaptureSource(options.sourceId);
  const fps = options.fps ?? 60;
  const desktopWindow = options.pipeline === 'canvas' ? undefined : getCurrentWindow();
  const wasAlwaysOnTop = desktopWindow ? await desktopWindow.isAlwaysOnTop() : false;
  const wasMaximized = desktopWindow ? await desktopWindow.isMaximized() : false;
  await desktopWindow?.setAlwaysOnTop(true);
  // Use the permitted title-bar action so A/B capture covers the same animated desktop area.
  if (desktopWindow && !wasMaximized) {
    await invoke('plugin:window|internal_toggle_maximize', { label: desktopWindow.label });
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:100000;background:#000';
  document.body.appendChild(canvas);
  const context = canvas.getContext('2d', { alpha: false })!;
  let frame = 0;
  let animation = 0;
  const draw = () => {
    context.fillStyle = '#182430';
    context.fillRect(0, 0, 1920, 1080);
    for (let row = 0; row < 9; row++) {
      context.fillStyle = `hsl(${row * 40},65%,55%)`;
      context.fillRect((frame * 14 + row * 110) % 1920, row * 120, 200, 100);
    }
    context.fillStyle = '#fff';
    context.font = '48px sans-serif';
    context.fillText(`1080p / target ${fps} FPS — frame ${frame++}`, 40, 65);
    animation = requestAnimationFrame(draw);
  };
  animation = requestAnimationFrame(draw);
  const bridge = new NativeVideoBridge();
  const connections: RTCPeerConnection[] = [];
  const videos: HTMLVideoElement[] = [];
  let stream: MediaStream | undefined;
  let imageMessages = 0;
  let heartbeatMessages = 0;
  let jpegBytes = 0;
  const imageTimes: number[] = [];
  const writerTimes: number[] = [];
  const receiverTimes: Array<{ media: number[]; display: number[] }> = [];
  let secondaryBridge: NativeVideoBridge | undefined;
  let loadScenario: unknown;
  try {
    stream = options.pipeline === 'canvas'
      ? canvas.captureStream(fps)
      : await bridge.startCapture(sourceId, fps, options.resolution ?? { width: 1920, height: 1080 }, false, 90);
    const track = stream.getVideoTracks()[0];
    const socket = (bridge as unknown as { ws: WebSocket | null }).ws;
    const trackWriter = (bridge as unknown as { trackWriter: WritableStreamDefaultWriter<VideoFrame> | null }).trackWriter;
    if (trackWriter) {
      const originalWrite = trackWriter.write.bind(trackWriter);
      trackWriter.write = (frame) => { writerTimes.push(performance.now()); return originalWrite(frame); };
    }
    socket?.addEventListener('message', ({ data }) => {
      if (data instanceof ArrayBuffer) {
        if (data.byteLength > 4) { imageMessages++; jpegBytes += data.byteLength; imageTimes.push(performance.now()); }
        else heartbeatMessages++;
      }
    });
    if (options.probe) await MediaCoordinator.prepareCodecPreferences(options.resolution?.width ?? 1920,
      options.resolution?.height ?? 1080, fps, 15_000_000);
    for (let index = 0; index < (options.peers ?? 1); index++) {
      const sender = new RTCPeerConnection({ iceServers: [] });
      const receiver = new RTCPeerConnection({ iceServers: [] });
      connections.push(sender, receiver);
      sender.onicecandidate = ({ candidate }) => { if (candidate) void receiver.addIceCandidate(candidate); };
      receiver.onicecandidate = ({ candidate }) => { if (candidate) void sender.addIceCandidate(candidate); };
      receiver.ontrack = ({ track: incoming }) => {
        const video = document.createElement('video');
        video.muted = true;
        video.autoplay = true;
        video.srcObject = new MediaStream([incoming]);
        video.style.cssText = `position:fixed;right:${index * 244}px;bottom:0;width:240px;z-index:100001`;
        // Avoid recursively capturing receiver thumbnails in controlled A/B capture runs.
        if (options.hideReceivers) video.style.opacity = '0';
        document.body.appendChild(video);
        videos.push(video);
        const timing = { media: [] as number[], display: [] as number[] };
        receiverTimes.push(timing);
        const rendered: VideoFrameRequestCallback = (_now, metadata) => {
          timing.media.push(metadata.mediaTime * 1000);
          timing.display.push(metadata.expectedDisplayTime);
          if (video.isConnected) video.requestVideoFrameCallback(rendered);
        };
        video.requestVideoFrameCallback(rendered);
        void video.play();
      };
      sender.addTrack(track, stream);
      MediaCoordinator.configureCodecPreferences(sender);
      await sender.setLocalDescription(await sender.createOffer());
      await receiver.setRemoteDescription(sender.localDescription!);
      await receiver.setLocalDescription(await receiver.createAnswer());
      await sender.setRemoteDescription(receiver.localDescription!);
      await MediaCoordinator.applySenderBitrate(sender, 15_000_000, fps);
    }
    await new Promise((resolve) => setTimeout(resolve, options.warmupMs ?? 8000));
    const sample = async () => Promise.all(connections.map(async (pc) => {
      const stats = await pc.getStats();
      return Array.from(stats.values()).filter((entry) =>
        ['outbound-rtp', 'inbound-rtp', 'media-source', 'codec', 'candidate-pair'].includes(entry.type));
    }));
    if (options.loadScenario) {
      if (options.pipeline === 'canvas') throw new Error('Load scenario requires native capture');
      secondaryBridge = new NativeVideoBridge(crypto.randomUUID());
      await secondaryBridge.startCapture(sourceId, 30, { width: 640, height: 360 }, false, 90);
      const writer = (bridge as unknown as { trackWriter: WritableStreamDefaultWriter<VideoFrame> }).trackWriter;
      if (!writer) throw new Error('Load scenario requires the track generator');
      const originalWrite = writer.write.bind(writer);
      let slowWrite = true;
      writer.write = async (frame) => {
        if (slowWrite) await new Promise(resolve => setTimeout(resolve, 100));
        return originalWrite(frame);
      };
      const phases = [];
      const overloadSamples = options.loadScenario === 'sustained' ? 11 : 3;
      const totalSamples = options.loadScenario === 'sustained' ? 38 : 16;
      try {
        for (let index = 0; index < totalSamples; index++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          if (index === overloadSamples - 1) slowWrite = false;
          const metrics = await invoke<{ load: { resolution_scale_percent: number; effective_fps: number; adjustments: number } }>(
            'get_capture_metrics', { sessionId: bridge.sessionId });
          const secondary = await invoke<{ load: { adjustments: number } }>('get_capture_metrics', { sessionId: secondaryBridge.sessionId });
          const bitmap = (bridge as unknown as { latestBitmap: ImageBitmap | null }).latestBitmap;
          phases.push({ seconds: (index + 1) * 2, injectedSlowWrite: index < overloadSamples, metrics, secondary,
            bitmap: bitmap ? { width: bitmap.width, height: bitmap.height } : undefined, rtp: await sample() });
        }
        const loads = phases.map(phase => phase.metrics.load);
        if (!loads.some(load => load.resolution_scale_percent < 100)) throw new Error('Sustained bridge load was not adapted');
        if (options.loadScenario === 'sustained' && !loads.some(load => load.effective_fps === Math.max(15, Math.floor(fps / 2)))) {
          throw new Error('Sustained overload did not reach the bounded FPS fallback');
        }
        if (loads.at(-1)?.resolution_scale_percent !== 100 || loads.at(-1)?.effective_fps !== fps) {
          throw new Error('Capture did not recover its requested settings');
        }
        if (phases.some(phase => phase.secondary.load.adjustments !== 0)) throw new Error('Adaptation leaked into the second capture');
        loadScenario = phases;
      } finally {
        slowWrite = false;
        writer.write = originalWrite;
      }
    }
    const before = await sample();
    const nativeBefore = options.pipeline === 'canvas' ? undefined : await invoke('get_capture_metrics', { sessionId: bridge.sessionId });
    const captureBefore = { imageMessages, heartbeatMessages, jpegBytes, timestamp: performance.now() };
    imageTimes.length = writerTimes.length = 0;
    receiverTimes.forEach(timing => { timing.media.length = timing.display.length = 0; });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const after = await sample();
    const intervals = (times: number[]) => {
      const gaps = times.slice(1).map((value, index) => value - times[index]).sort((a, b) => a - b);
      const percentile = (fraction: number) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * fraction))];
      return { samples: gaps.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99),
        minMs: gaps[0], maxMs: gaps.at(-1) };
    };
    const cadence = { websocketImages: intervals(imageTimes), trackWrites: intervals(writerTimes),
      receivers: receiverTimes.map(timing => ({ media: intervals(timing.media), display: intervals(timing.display) })) };
    const nativeAfter = options.pipeline === 'canvas' ? undefined : await invoke('get_capture_metrics', { sessionId: bridge.sessionId });
    const sourceState = bridge as unknown as { latestBitmap: ImageBitmap | null; latestEncodedFrame: VideoFrame | null };
    const sourceBitmap = sourceState.latestEncodedFrame || sourceState.latestBitmap;
    const pixelRange = (source: CanvasImageSource) => {
      const sample = document.createElement('canvas'); sample.width = 64; sample.height = 36;
      const ctx = sample.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(source, 0, 0, 64, 36);
      const pixels = ctx.getImageData(0, 0, 64, 36).data;
      let min = 255; let max = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        for (let channel = 0; channel < 3; channel++) {
          min = Math.min(min, pixels[offset + channel]); max = Math.max(max, pixels[offset + channel]);
        }
      }
      return { min, max };
    };
    const visualChecks = { source: sourceBitmap ? pixelRange(sourceBitmap) : undefined,
      receivers: videos.map(video => ({ width: video.videoWidth, height: video.videoHeight, ...pixelRange(video) })) };
    if (visualChecks.receivers.some(video => video.max <= 8)) throw new Error('Decoded receiver is black');
    const snapshot = document.createElement('canvas');
    snapshot.width = 480;
    snapshot.height = 270;
    if (sourceBitmap) snapshot.getContext('2d')!.drawImage(sourceBitmap, 0, 0, 480, 270);
    return { nativeBefore, nativeAfter, loadScenario, cadence, visualChecks, sourceSnapshot: sourceBitmap ? snapshot.toDataURL() : undefined, options, animationFrames: frame, source: track.getSettings(), before, after,
      captureBefore, captureAfter: { imageMessages, heartbeatMessages, jpegBytes, timestamp: performance.now() } };
  } finally {
    connections.forEach((pc) => pc.close());
    videos.forEach((video) => { video.srcObject = null; video.remove(); });
    stream?.getTracks().forEach((track) => track.stop());
    await bridge.stopCapture();
    await secondaryBridge?.stopCapture();
    cancelAnimationFrame(animation);
    canvas.remove();
    await desktopWindow?.setAlwaysOnTop(wasAlwaysOnTop);
    if (desktopWindow && !wasMaximized && await desktopWindow.isMaximized()) {
      await invoke('plugin:window|internal_toggle_maximize', { label: desktopWindow.label });
    }
  }
}
