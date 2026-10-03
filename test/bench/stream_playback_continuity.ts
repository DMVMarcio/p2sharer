import { resolveCaptureSource } from './capture_source';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GroupRoomManager } from '../../src/p2p/group_room';
import { NativeVideoBridge } from '../../src/video/native_video_bridge';
import { RoomVideoContainer } from '../../src/components/room/RoomVideoContainer';
import { ContextMenuProvider } from '../../src/components/common/ContextMenu';
import { stateStore } from '../../src/core/state_store';
import { roomService } from '../../src/services/room_service';
import { pipService } from '../../src/services/pip_service';
import { audioContextManager } from '../../src/audio/audio_context_manager';

let manager: GroupRoomManager | undefined, root: Root | undefined;
let surface: HTMLElement | undefined, canvas: HTMLCanvasElement | undefined;
let animation = 0, audio: AudioContext | undefined;
const bridges: NativeVideoBridge[] = [];
const identities = new Map<string, Set<string>>();
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** Load in two packaged desktop processes, with distinct WebView profiles and CDP ports. */
export async function joinPlaybackRoom(room: string, password: string, name: string) {
  manager = new GroupRoomManager(name, room, password, false);
  roomService.roomManager = manager;
  stateStore.set(state => { state.username = name; state.roomSlots = []; state.layoutMode = 'grid'; });
  surface = document.createElement('div');
  surface.style.cssText = 'position:fixed;inset:0;z-index:90000;background:#222';
  document.body.appendChild(surface);
  root = createRoot(surface);
  root.render(React.createElement(ContextMenuProvider, null, React.createElement(RoomVideoContainer)));
  await manager.join({ onStreamsUpdate: () => {}, onPeersUpdate: () => {}, onStatusChange: () => {},
    onChat: () => {}, onChatHistory: () => {}, onSlotsUpdate: slots => {
      for (const slot of slots) if (!slot.isLocal && slot.stream) {
        const ids = identities.get(slot.peerId) || new Set<string>(); ids.add(slot.stream.id); identities.set(slot.peerId, ids);
      }
      stateStore.set(state => { state.roomSlots = slots;
        state.subscribedStreams = new Set(slots.filter(slot => !slot.isLocal && slot.isStreaming).map(slot => slot.peerId)); });
    } });
  return manager.getLocalPeerId();
}

export async function publishPlaybackSources(requestedSource?: string) {
  const sourceId = await resolveCaptureSource(requestedSource);
  check(manager, 'Join the QA room first');
  canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:100000'; document.body.appendChild(canvas);
  let frame = 0;
  const draw = () => { const ctx = canvas!.getContext('2d')!; ctx.fillStyle = `hsl(${frame++ % 360},60%,45%)`;
    ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = '#fff'; ctx.font = '40px sans-serif';
    ctx.fillText(`Continuity ${frame}`, 50, 100); animation = requestAnimationFrame(draw); }; draw();
  audio = new AudioContext(); await audio.resume();
  const oscillator = audio.createOscillator(), gain = audio.createGain(), destination = audio.createMediaStreamDestination();
  oscillator.frequency.value = 440; gain.gain.value = 0.1;
  oscillator.connect(gain); gain.connect(destination); oscillator.start();
  for (const [width, height, fps] of [[1280, 720, 60], [640, 360, 30]]) {
    const bridge = new NativeVideoBridge(crypto.randomUUID()); bridges.push(bridge);
    const stream = await bridge.startCapture(sourceId, fps, { width, height }, false, 90);
    if (bridges.length === 1) stream.addTrack(destination.stream.getAudioTracks()[0]);
    manager.shareStream(stream, 8_000_000, fps, { id: bridge.sessionId, kind: 'screen', label: `Continuity ${width}`,
      videoTrackId: stream.getVideoTracks()[0].id, fps, bitrate: 8000 });
  }
}

/** Samples the canonical React cards through six presence cycles, then native PiP and restore. */
export async function validatePlaybackContinuity(pipDuration = 5000) {
  check(manager && surface, 'Join the QA room first');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && stateStore.roomSlots.filter(s => !s.isLocal && s.stream?.getVideoTracks().length).length < 2) await wait(200);
  await wait(3000);
  const remote = stateStore.roomSlots.filter(s => !s.isLocal && s.stream?.getVideoTracks().length);
  check(remote.length === 2, 'Both screen sources must arrive');
  const primary = remote.find(s => s.stream!.getAudioTracks().length)!;
  check(primary, 'Primary audio must arrive');
  const card = surface.querySelector<HTMLElement>(`[data-peer-id="${primary.peerId}"]`)!;
  const toggle = card.querySelector<HTMLButtonElement>('[aria-label="Apontar na transmissão"]');
  check(toggle, 'Pointing toggle must be available'); toggle.click(); await wait(100);
  const videos = Array.from(surface.querySelectorAll('video'));
  check(videos.length === 2, 'Grid must contain two actual video cards');
  const sources = videos.map(v => v.srcObject);
  const resets = videos.map(() => 0);
  videos.forEach((v, i) => v.addEventListener('emptied', () => resets[i]++));
  const sink = audioContextManager.attachPeerAudio(primary.peerId, primary.stream!);
  const audioSource = sink.source;
  const analyser = sink.audioCtx.createAnalyser(); analyser.fftSize = 2048; sink.gainNode.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const sampleAudio = () => { analyser.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length); };
  const measure = async (duration: number, withVideo: boolean) => {
    let silent = 0, count = 0, black = 0, minRms = Infinity, silenceStarted = 0, maxSilenceMs = 0;
    const probe = document.createElement('canvas'); probe.width = 1; probe.height = 1; const context = probe.getContext('2d')!;
    const until = Date.now() + duration;
    while (Date.now() < until) {
      const rms = sampleAudio(); minRms = Math.min(minRms, rms);
      if (rms < 0.005) { silent++; silenceStarted ||= Date.now(); maxSilenceMs = Math.max(maxSilenceMs, Date.now() - silenceStarted + 50); }
      else silenceStarted = 0;
      count++;
      if (withVideo) for (const video of videos) {
        context.drawImage(video, 0, 0, 1, 1); const pixel = context.getImageData(0, 0, 1, 1).data;
        if (pixel[0] + pixel[1] + pixel[2] < 15) black++;
      }
      await wait(50);
    }
    return { count, silent, black, minRms, maxSilenceMs };
  };
  const grid = await measure(12_000, true);
  check(videos.every((v, i) => v.srcObject === sources[i]), 'Presence must not replace playback containers');
  check(resets.every(n => n === 0), 'Presence must not empty a video player');
  check(toggle.getAttribute('aria-pressed') === 'true', 'Pointing must remain enabled across presence updates');
  check(sink.source === audioSource, 'Presence must not rebuild the audio source');
  check(grid.maxSilenceMs < 150 && grid.black === 0, `Grid must retain video and tone without sustained cuts: ${JSON.stringify(grid)}`);
  const gridResets = [...resets];
  await pipService.openPip(primary.peerId, primary.senderName, primary.stream!); await wait(3000);
  check(!card.querySelector('video'), 'Main card must release its visible video while PiP is active');
  const pip = await measure(pipDuration, false);
  check(pip.maxSilenceMs < 150, `PiP must preserve actual remote audio samples without the main video: ${JSON.stringify(pip)}`);
  await pipService.restoreFromPip(primary.peerId); await wait(1500);
  const restored = await measure(3000, false); check(restored.maxSilenceMs < 150, 'Restoring PiP must preserve audio');
  sink.gainNode.disconnect(analyser); analyser.disconnect();
  return { grid, pip, restored, gridResets, identities: remote.map(s => ({ key: s.peerId, count: identities.get(s.peerId)?.size })),
    stats: await Promise.all(remote.map(s => manager!.getPeerStats(s.peerId))) };
}

export async function playbackSenderStats() {
  check(manager, 'Join the QA room first');
  const internal = manager as any;
  return { native: await Promise.all(bridges.map(b => internal.nativeVideo?.senderStats(b.sessionId))),
    browserVideoSenders: Object.values(internal.room?.getPeers?.() ?? {}).reduce((n: number, pc: any) =>
      n + pc.getSenders().filter((s: RTCRtpSender) => s.track?.kind === 'video').length, 0) };
}

export async function playbackAudioProbe() {
  const slot = stateStore.roomSlots.find(s => !s.isLocal && s.stream?.getAudioTracks().length);
  check(slot?.stream, 'Audio stream missing');
  const sink = audioContextManager.attachPeerAudio(slot.peerId, slot.stream);
  const analyser = sink.audioCtx.createAnalyser(); analyser.fftSize = 2048; sink.gainNode.connect(analyser);
  await wait(300);
  const samples = new Float32Array(2048); analyser.getFloatTimeDomainData(samples);
  sink.gainNode.disconnect(analyser);
  return { rms: Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length), context: sink.audioCtx.state,
    gain: sink.gainNode.gain.value, tracks: slot.stream.getAudioTracks().map(t => ({ id: t.id, muted: t.muted, enabled: t.enabled })) };
}

export async function closePlaybackRoom() {
  for (const peer of stateStore.activePipPeers) await pipService.restoreFromPip(peer);
  root?.unmount(); surface?.remove(); await manager?.leave(); manager = undefined; roomService.roomManager = null;
  for (const bridge of bridges) await bridge.stopCapture(); bridges.length = 0;
  cancelAnimationFrame(animation); canvas?.remove(); audioContextManager.cleanup();
  if (audio && audio.state !== 'closed') await audio.close(); audio = undefined;
}
