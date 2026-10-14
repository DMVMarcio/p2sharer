import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserMedia } from '../../src/apps/browser_media.ts';
import { MockMediaStream, MockMediaStreamTrack } from '../helpers/browser_mocks.ts';
import { BrowserQualityController, validBrowserQuality } from '../../src/apps/browser_quality.ts';
import { AudioBridge } from '../../src/audio/audio_bridge.ts';

test('host capture requests completed frames, subtracts processing time and discards retired captures', async () => {
  const originals = new Map(['window', 'document', 'performance', 'createImageBitmap', 'setTimeout', 'clearTimeout']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const init = AudioBridge.prototype.init; const listen = AudioBridge.prototype.startListening;
  let now = 0; let requests = 0; let frames = 0; let draws = 0; let closed = 0;
  let resolveCapture: (value: unknown) => void = () => {};
  let scheduled: (() => void) | null = null; let delay = 0;
  const track = new MockMediaStreamTrack('video'); Object.assign(track, { requestFrame: () => frames++ });
  const stream = new MockMediaStream(); stream.addTrack(track);
  const canvas = { width: 0, height: 0, captureStream: (fps: number) => { assert.equal(fps, 0); return stream; },
    getContext: () => ({ drawImage: () => draws++ }) };
  const replace = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  replace('window', { __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => {
    assert.equal(command, 'capture_shared_browser'); assert.equal(args.width, 1280); requests++;
    return new Promise(resolve => { resolveCapture = resolve; });
  } } });
  replace('document', { createElement: () => canvas }); replace('performance', { now: () => now });
  replace('createImageBitmap', async () => { now += 5; return { close: () => closed++ }; });
  replace('setTimeout', (callback: () => void, milliseconds: number) => { scheduled = callback; delay = milliseconds; return 1; });
  replace('clearTimeout', () => { scheduled = null; });
  AudioBridge.prototype.init = () => null; AudioBridge.prototype.startListening = async () => {};
  const media = new BrowserMedia(crypto.randomUUID(), true, async () => {}, () => {}, () => {}, error => { throw error; });
  try {
    media.configure({ mode: 'video', video: '720p30' }); await media.start();
    assert.equal(requests, 1); assert.equal(scheduled, null, 'an unfinished capture never queues another');
    now = 12; resolveCapture({ image: 'AA==', state: null, playing: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames, 1); assert.equal(draws, 1); assert.equal(closed, 1);
    assert.ok(Math.abs(delay - (1000 / 30 - 17)) < 0.01, 'processing belongs inside the frame period');
    assert.equal(track.contentHint, 'motion'); assert.equal(canvas.height, 720);
    scheduled!(); assert.equal(requests, 2); media.stop();
    resolveCapture({ image: 'AA==', state: null, playing: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(draws, 1); assert.equal(scheduled, null); assert.equal(track.readyState, 'ended');
  } finally {
    media.stop(); AudioBridge.prototype.init = init; AudioBridge.prototype.startListening = listen;
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('browser quality detects playback, holds through short pauses and restores reading', () => {
  const quality = new BrowserQualityController({ mode: 'auto', video: '1080p30' });
  assert.deepEqual(quality.quality, { width: 1280, height: 720, fps: 15, video: false });
  quality.detect(true, 1000);
  assert.equal(quality.quality.fps, 30);
  quality.detect(false, 3500); assert.equal(quality.quality.video, true);
  quality.detect(false, 4000); assert.equal(quality.quality.video, false);
  quality.configure({ mode: 'video', video: '720p30' });
  assert.equal(quality.quality.video, true);
  quality.configure({ mode: 'reading', video: '1080p60' });
  quality.detect(true, 5000); assert.equal(quality.quality.fps, 15);
  quality.reset(); quality.configure({ mode: 'auto', video: '1080p30' });
  assert.equal(quality.quality.video, false);
  assert.equal(validBrowserQuality({ mode: 'video', video: '4k120' }), false);
});

test('browser quality upgrades on sustained capture headroom, respects ceilings and backs off under load', () => {
  const quality = new BrowserQualityController({ mode: 'video', video: '1080p60' });
  for (let now = 0; now <= 8000; now += 100) quality.sample(5, now);
  assert.equal(quality.quality.height, 1080); assert.equal(quality.quality.fps, 30);
  for (let now = 8100; now <= 23000; now += 100) quality.sample(5, now);
  assert.equal(quality.quality.fps, 60);
  for (let now = 23100; now <= 29000; now += 100) quality.sample(35, now);
  assert.deepEqual(quality.quality, { width: 1280, height: 720, fps: 30, video: true });
  for (let now = 29100; now <= 36000; now += 100) quality.sample(5, now);
  assert.equal(quality.quality.height, 720, 'cooldown prevents repeated quality oscillation');
  quality.configure({ mode: 'video', video: '720p30' });
  for (let now = 40000; now <= 80000; now += 100) quality.sample(1, now);
  assert.equal(quality.quality.height, 720); assert.equal(quality.quality.fps, 30);
  quality.configure({ mode: 'video', video: '1080p30' });
  for (let now = 90000; now <= 130000; now += 100) quality.sample(1, now);
  assert.equal(quality.quality.height, 1080); assert.equal(quality.quality.fps, 30);
});

test('browser media announces SDP before trickle ICE, rejects stale candidates and stops replaced tracks', async () => {
  const previousPc = globalThis.RTCPeerConnection;
  const previousStream = globalThis.MediaStream;
  const created: Connection[] = [];
  class Connection {
    configuration: unknown;
    remoteDescription: unknown = null;
    localDescription: { toJSON(): unknown } | null = null;
    onicecandidate: ((event: unknown) => void) | null = null;
    ontrack: ((event: unknown) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    connectionState = 'new';
    signalingState = 'stable';
    closed = false;
    candidates: unknown[] = [];
    constructor(configuration: unknown) { this.configuration = configuration; created.push(this); }
    async setRemoteDescription(value: unknown) { this.remoteDescription = value; }
    async createAnswer() { return { type: 'answer', sdp: 'test-answer' }; }
    async setLocalDescription(value: unknown) {
      this.localDescription = { toJSON: () => value };
      this.onicecandidate?.({ candidate: { toJSON: () => ({candidate:'test-local-candidate'}) } });
    }
    async addIceCandidate(value: unknown) { this.candidates.push(value); }
    close() { this.closed = true; }
  }
  globalThis.RTCPeerConnection = Connection as unknown as typeof RTCPeerConnection;
  globalThis.MediaStream = MockMediaStream as unknown as typeof MediaStream;
  const sent: Record<string, unknown>[] = [];
  const configuration: RTCConfiguration = { iceServers: [], iceTransportPolicy: 'all' };
  const media = new BrowserMedia(crypto.randomUUID(), false, async payload => { sent.push(payload as Record<string, unknown>); }, () => {}, () => {}, error => { throw error; }, () => configuration);
  try {
    await media.start();
    const token = crypto.randomUUID();
    await media.receive('host', { token, description: {type:'offer', sdp:'test-offer'} });
    assert.deepEqual(created[0].configuration, configuration);
    assert.equal((sent[0].description as {type:string}).type, 'answer');
    assert.deepEqual(sent[1].candidate, {candidate:'test-local-candidate'});
    await media.receive('host', {token:crypto.randomUUID(), candidate:{candidate:'stale'}});
    assert.equal(created[0].candidates.length, 0);
    await media.receive('host', {token, candidate:{candidate:'current'}});
    assert.equal(created[0].candidates.length, 1);
    const track = new MockMediaStreamTrack('video');
    created[0].ontrack?.({track}); assert.equal(media.stream?.getTracks().length, 1);
    media.remove('another-participant');
    assert.equal(track.readyState, 'live'); assert.equal(media.stream?.getTracks().length, 1);
    await media.receive('host', {token:crypto.randomUUID(), description:{type:'offer',sdp:'replacement'}});
    assert.equal(created[0].closed, true); assert.equal(track.readyState, 'ended');
    created[1].connectionState = 'disconnected'; created[1].onconnectionstatechange?.();
    media.stop(); assert.equal(created[1].closed, true); assert.equal(media.stream, null);
  } finally { media.stop(); globalThis.RTCPeerConnection = previousPc; globalThis.MediaStream = previousStream; }
});
