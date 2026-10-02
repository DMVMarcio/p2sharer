import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { NativeVideoBridge } from '../../src/video/native_video_bridge';
import { MediaCoordinator } from '../../src/p2p/media_coordinator';

/** Run inside the desktop WebView2 to exercise native capture and real RTP encoding. */
export async function runVideoLoopback(options: {
  peers?: number;
  pipeline?: 'native' | 'canvas';
  probe?: boolean;
  hideReceivers?: boolean;
  resolution?: { width: number; height: number };
} = {}) {
  const desktopWindow = options.pipeline === 'canvas' ? undefined : getCurrentWindow();
  const wasAlwaysOnTop = desktopWindow ? await desktopWindow.isAlwaysOnTop() : false;
  await desktopWindow?.setAlwaysOnTop(true);
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
    context.fillText(`1080p / 60 FPS — frame ${frame++}`, 40, 65);
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
  try {
    stream = options.pipeline === 'canvas'
      ? canvas.captureStream(60)
      : await bridge.startCapture('screen:0', 60, options.resolution ?? { width: 1920, height: 1080 }, false, 90);
    const track = stream.getVideoTracks()[0];
    const socket = (bridge as unknown as { ws: WebSocket | null }).ws;
    socket?.addEventListener('message', ({ data }) => {
      if (data instanceof ArrayBuffer) {
        if (data.byteLength > 4) { imageMessages++; jpegBytes += data.byteLength; }
        else heartbeatMessages++;
      }
    });
    if (options.probe) await MediaCoordinator.prepareCodecPreferences(options.resolution?.width ?? 1920,
      options.resolution?.height ?? 1080, 60, 15_000_000);
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
        video.style.cssText = 'position:fixed;right:0;bottom:0;width:240px;z-index:100001';
        // Avoid recursively capturing receiver thumbnails in controlled A/B capture runs.
        if (options.hideReceivers) video.style.opacity = '0';
        document.body.appendChild(video);
        videos.push(video);
        void video.play();
      };
      sender.addTrack(track, stream);
      MediaCoordinator.configureCodecPreferences(sender);
      await sender.setLocalDescription(await sender.createOffer());
      await receiver.setRemoteDescription(sender.localDescription!);
      await receiver.setLocalDescription(await receiver.createAnswer());
      await sender.setRemoteDescription(receiver.localDescription!);
      await MediaCoordinator.applySenderBitrate(sender, 15_000_000, 60);
    }
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const sample = async () => Promise.all(connections.map(async (pc) => {
      const stats = await pc.getStats();
      return Array.from(stats.values()).filter((entry) =>
        ['outbound-rtp', 'inbound-rtp', 'media-source', 'codec', 'candidate-pair'].includes(entry.type));
    }));
    const before = await sample();
    const nativeBefore = options.pipeline === 'canvas' ? undefined : await invoke('get_capture_metrics', { sessionId: bridge.sessionId });
    const captureBefore = { imageMessages, heartbeatMessages, jpegBytes, timestamp: performance.now() };
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const after = await sample();
    const nativeAfter = options.pipeline === 'canvas' ? undefined : await invoke('get_capture_metrics', { sessionId: bridge.sessionId });
    const sourceBitmap = (bridge as unknown as { latestBitmap: ImageBitmap | null }).latestBitmap;
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
    return { nativeBefore, nativeAfter, visualChecks, sourceSnapshot: sourceBitmap ? snapshot.toDataURL() : undefined, options, animationFrames: frame, source: track.getSettings(), before, after,
      captureBefore, captureAfter: { imageMessages, heartbeatMessages, jpegBytes, timestamp: performance.now() } };
  } finally {
    connections.forEach((pc) => pc.close());
    videos.forEach((video) => { video.srcObject = null; video.remove(); });
    stream?.getTracks().forEach((track) => track.stop());
    await bridge.stopCapture();
    cancelAnimationFrame(animation);
    canvas.remove();
    await desktopWindow?.setAlwaysOnTop(wasAlwaysOnTop);
  }
}
