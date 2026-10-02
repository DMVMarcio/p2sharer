import createPeer from '../../node_modules/@trystero-p2p/core/dist/peer.mjs';
import { createMediaIdentityCache, createMediaManager } from '../../node_modules/@trystero-p2p/core/dist/media.mjs';
import { NativeVideoBridge } from '../../src/video/native_video_bridge';
import { invoke } from '@tauri-apps/api/core';
import { getAllWebviewWindows } from '@tauri-apps/api/webviewWindow';

export async function runPointerIsolation() {
  const bridges = [new NativeVideoBridge(`qa-pointer-${crypto.randomUUID()}`), new NativeVideoBridge(`qa-pointer-${crypto.randomUUID()}`)];
  try {
    for (const bridge of bridges) await bridge.startCapture('screen:0', 30, { width: 320, height: 180 }, false, 75);
    const expires = Date.now() + 3000;
    for (const [index, bridge] of bridges.entries()) await invoke('update_stream_pointer_overlay', {
      sessionId: bridge.sessionId, visuals: [{ id: `pointer-${index}`, name: `Screen ${index}`, color: '#5599ff',
        x: 0.2 + index * 0.5, y: 0.4, ping: false, expires }],
    });
    const labels = (await getAllWebviewWindows()).map(window => window.label).filter(label => label.startsWith('stream-pointer-qa-pointer-'));
    if (labels.length !== 2) throw new Error(`Expected two native pointer windows, found ${labels.length}`);
    await new Promise(resolve => setTimeout(resolve, 700));
    await invoke('update_stream_pointer_overlay', { sessionId: bridges[0].sessionId, visuals: [] });
    const deadline = performance.now() + 1500;
    let remaining = 2;
    while (remaining === 2 && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      remaining = (await getAllWebviewWindows()).filter(window => labels.includes(window.label)).length;
    }
    if (remaining !== 1) throw new Error('Stopping one pointer window affected the other');
    return { independentWindows: labels.length, remainingAfterOneStops: remaining };
  } finally {
    for (const bridge of bridges) await invoke('update_stream_pointer_overlay', { sessionId: bridge.sessionId, visuals: [] });
    await Promise.all(bridges.map(bridge => bridge.stopCapture()));
  }
}

/** Desktop-only regression exercise: actual Trystero media pairing, WGC and RTP. */
export async function runMultipleMediaLoopback() {
  const sender = createPeer(true, { rtcConfig: { iceServers: [] }, _test_only_mdnsHostFallbackToLoopback: true });
  const receiver = createPeer(false, { rtcConfig: { iceServers: [] }, _test_only_mdnsHostFallbackToLoopback: true });
  receiver.__trysteroMedia = createMediaIdentityCache();
  const incoming = new Map<string, MediaStream>();
  const errors: string[] = [];
  const videos = new Map<string, HTMLVideoElement>();
  const captures: MediaStream[] = [];
  const bridges: NativeVideoBridge[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  const audio = new AudioContext();
  const oscillator = audio.createOscillator();
  const destination = audio.createMediaStreamDestination();
  oscillator.connect(destination); oscillator.start();
  const rx = createMediaManager({ iterate: () => [], isActive: () => true, getSharedMediaPeer: () => receiver });
  const tx = createMediaManager({ isActive: () => true, getSharedMediaPeer: () => sender,
    iterate: (_targets, callback) => [callback('receiver', sender)] });
  rx.onPeerStream = (stream, _owner, meta) => {
    incoming.set(meta.id, stream);
    let video = videos.get(meta.id);
    if (!video) {
      video = document.createElement('video');
      video.muted = true; video.autoplay = true; video.style.cssText = 'position:fixed;left:0;bottom:0;width:160px;z-index:10000';
      document.body.appendChild(video); videos.set(meta.id, video);
    }
    video.srcObject = stream; void video.play();
  };
  sender.setHandlers({ signal: signal => receiver.signal(signal), error: error => errors.push(String(error)) });
  receiver.setHandlers({ signal: signal => sender.signal(signal), error: error => errors.push(String(error)),
    data: data => rx.receiveStreamMeta(JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)), 'sender'),
    stream: stream => rx.receiveRemoteStream('sender', stream) });
  const wait = async (predicate: () => boolean, label: string) => {
    const start = performance.now();
    while (!predicate()) {
      if (performance.now() - start > 7000) throw new Error(`Timeout: ${label}; ${errors.join('; ')}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const publish = async (id: string, stream: MediaStream) => {
    await Promise.all(tx.addStream(stream, { target: 'receiver', metadata: { id } }, meta => {
      sender.sendData(JSON.stringify(meta)); return Promise.resolve();
    }));
    await wait(() => !!videos.get(id)?.videoWidth, `decoded ${id}`);
  };
  try {
    await wait(() => sender.connection.connectionState === 'connected', 'WebRTC connection');
    const primary = new NativeVideoBridge(`qa-primary-${crypto.randomUUID()}`);
    bridges.push(primary);
    const screen = await primary.startCapture('screen:0', 30, { width: 640, height: 360 }, false, 75);
    screen.addTrack(destination.stream.getAudioTracks()[0]);
    captures.push(screen);
    await publish('screen', screen);
    const originalScreen = incoming.get('screen');
    const cycles = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      const bridge = new NativeVideoBridge(`qa-extra-${crypto.randomUUID()}`);
      bridges.push(bridge);
      const extra = await bridge.startCapture('screen:0', 30, { width: 320, height: 180 }, false, 75);
      const camera = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, frameRate: 30 }, audio: false });
      captures.push(extra, camera);
      await publish(`extra-${cycle}`, extra);
      await publish(`camera-${cycle}`, camera);
      // Recovery republishes all existing sources without duplicating senders.
      await publish('screen', screen);
      if (incoming.get('screen') !== originalScreen) throw new Error('Main screen identity changed');
      if (incoming.get(`camera-${cycle}`) === originalScreen) throw new Error('Camera overwrote the screen');
      const before = [...(await receiver.connection.getStats()).values()].filter(v => v.type === 'inbound-rtp' && v.kind === 'video');
      await new Promise(resolve => setTimeout(resolve, 800));
      const after = [...(await receiver.connection.getStats()).values()].filter(v => v.type === 'inbound-rtp' && v.kind === 'video');
      const progressing = after.filter(v => v.framesDecoded > (before.find(previous => previous.id === v.id)?.framesDecoded ?? 0)).length;
      if (progressing < 3) throw new Error(`Only ${progressing} of three RTP videos progressed`);
      cycles.push({ cycle, progressing, main: [videos.get('screen')!.videoWidth, videos.get('screen')!.videoHeight],
        camera: [videos.get(`camera-${cycle}`)!.videoWidth, videos.get(`camera-${cycle}`)!.videoHeight] });
      tx.removeStream(camera, 'receiver'); camera.getTracks().forEach(track => track.stop());
      tx.removeStream(extra, 'receiver'); await bridge.stopCapture();
      await new Promise(resolve => setTimeout(resolve, 150));
      if (screen.getVideoTracks()[0].readyState !== 'live') throw new Error('Stopping an extra source stopped the primary');
    }
    const portraitCanvas = document.createElement('canvas');
    portraitCanvas.width = 180; portraitCanvas.height = 320;
    let portraitFrame = 0;
    timers.push(setInterval(() => {
      const context = portraitCanvas.getContext('2d')!;
      context.fillStyle = `hsl(${portraitFrame++ % 360},70%,40%)`;
      context.fillRect(0, 0, 180, 320);
    }, 33));
    const portrait = portraitCanvas.captureStream(30); captures.push(portrait);
    await publish('portrait', portrait);
    const portraitSize = [videos.get('portrait')!.videoWidth, videos.get('portrait')!.videoHeight];
    if (portraitSize[0] !== 180 || portraitSize[1] !== 320) throw new Error(`Portrait video stretched: ${portraitSize}`);
    tx.removeStream(portrait, 'receiver'); portrait.getTracks().forEach(track => track.stop());
    return { cycles, portraitSize, errors, activeSenders: sender.connection.getSenders().filter(s => s.track?.readyState === 'live').length };
  } finally {
    sender.destroy(); receiver.destroy();
    timers.forEach(clearInterval);
    captures.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    await Promise.all(bridges.map(bridge => bridge.stopCapture()));
    videos.forEach(video => { video.srcObject = null; video.remove(); });
    oscillator.stop(); await audio.close();
  }
}
