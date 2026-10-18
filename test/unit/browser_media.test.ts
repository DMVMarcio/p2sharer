import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserMedia } from '../../src/apps/browser_media.ts';
import { MediaCoordinator } from '../../src/p2p/media_coordinator.ts';
import { MockMediaStream, MockMediaStreamTrack } from '../helpers/browser_mocks.ts';
import { BrowserQualityController, validBrowserQuality, browserVideoBitrate } from '../../src/apps/browser_quality.ts';
import { BrowserCapture, type BrowserCaptureDependencies } from '../../src/apps/browser_capture.ts';

test('shared browser and detached relay negotiate stereo in both media offer and viewer answer', async () => {
  const previous = globalThis.RTCPeerConnection;
  const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n';
  class Connection {
    signalingState = 'stable';
    localDescription: { toJSON(): unknown } | null = null;
    async createOffer() { return { type: 'offer', sdp }; }
    async createAnswer() { return { type: 'answer', sdp }; }
    async setLocalDescription(value: unknown) { this.localDescription = { toJSON: () => value }; }
    async setRemoteDescription() { this.signalingState = 'have-remote-offer'; }
    addTrack() {}
    close() {}
  }
  globalThis.RTCPeerConnection = Connection as unknown as typeof RTCPeerConnection;
  MediaCoordinator.initGlobalWebRtcMunging();
  const sent: any[] = [];
  const create = (host: boolean) => new BrowserMedia(crypto.randomUUID(), host,
    async payload => { sent.push(payload); }, () => {}, () => {}, error => { throw error; }, () => ({ iceServers: [] }));
  const host = create(true); const viewer = create(false);
  const track = new MockMediaStreamTrack('audio');
  try {
    host.relay(new MockMediaStream([track]) as unknown as MediaStream);
    await host.offer('viewer');
    await viewer.start();
    await viewer.receive('host', sent[0]);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map(value => value.description.type), ['offer', 'answer']);
    for (const message of sent) assert.match(message.description.sdp,
      /a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1\r\n/);
  } finally { host.stop(); viewer.stop(); globalThis.RTCPeerConnection = previous; }
});

test('browser capture uses a scoped native stream, updates profiles in place and replaces only changed tabs', async () => {
  let source = 'window:1'; let starts = 0; let profiles = 0; let stops = 0; let deliveries = 0;
  const quality = new BrowserQualityController({ mode: 'reading', video: '1080p30' });
  const calls: string[] = [];
  const native: BrowserCaptureDependencies = {
    async call(command) {
      calls.push(command);
      return (command === 'get_capture_metrics' ? { images: 0, processing_us: 0 } :
        { sourceId: source, state: { tabs: [], active: 1, temporary: false }, playing: false }) as never;
    },
    bridge(session) {
      assert.ok(session.startsWith('browser-'));
      return { async startCapture(_source, fps, size, cursor) {
        starts++; assert.equal(cursor, false); assert.ok([15, 30].includes(fps)); assert.equal(size.width, 1280);
        return {} as MediaStream;
      }, async updateProfile(fps, width) { profiles++; assert.equal(fps, 30); assert.equal(width, 1280); },
      getProcessingCost: () => 1, async stopCapture() { stops++; } };
    },
  };
  const capture = new BrowserCapture(crypto.randomUUID(), quality, () => deliveries++, () => {}, () => {}, error => { throw error; }, native);
  try {
    await capture.start(); assert.equal(starts, 1); assert.equal(deliveries, 1);
    quality.configure({ mode: 'video', video: '720p30' }); capture.requestRefresh();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(profiles, 1); assert.equal(starts, 1);
    source = 'window:2'; capture.requestRefresh();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 2); assert.equal(deliveries, 2);
    assert.ok(calls.every(command => ['prepare_shared_browser_capture', 'get_capture_metrics'].includes(command)));
  } finally { capture.stop(); }
  assert.equal(stops, 1);
});

test('retired native browser captures cannot publish a late track or reuse another generation', async () => {
  let resolveStart: (stream: MediaStream) => void = () => {}; let delivered = 0; let stopped = 0;
  const native: BrowserCaptureDependencies = {
    async call() { return { sourceId: 'window:1', state: { tabs: [], active: 1, temporary: false }, playing: false } as never; },
    bridge() { return { startCapture: () => new Promise(resolve => { resolveStart = resolve; }),
      updateProfile: async () => {}, getProcessingCost: () => 0, stopCapture: async () => { stopped++; } }; },
  };
  const scope = crypto.randomUUID(); const quality = new BrowserQualityController({ mode: 'reading', video: '720p30' });
  const capture = new BrowserCapture(scope, quality, () => delivered++, () => {}, () => {}, () => {}, native);
  const next = new BrowserCapture(scope, quality, () => {}, () => {}, () => {}, () => {}, native);
  assert.notEqual(capture.sessionId, next.sessionId);
  const start = capture.start(); await new Promise(resolve => setImmediate(resolve));
  capture.stop(); resolveStart({} as MediaStream); await start;
  assert.equal(delivered, 0); assert.equal(stopped, 2);
});

test('a tab changed during a native probe refreshes metadata before attaching its new capture', async () => {
  let stale = true; const sources: string[] = []; let metadata = 0;
  const native: BrowserCaptureDependencies = {
    async call(command) { return (command === 'get_capture_metrics' ? { images: 0, processing_us: 0 } :
      { sourceId: stale ? null : 'window:2', state: { tabs: [], active: 2, temporary: false }, playing: false }) as never; },
    bridge() { return { async startCapture(source) { sources.push(source); return {} as MediaStream; },
      updateProfile: async () => {}, getProcessingCost: () => 0, stopCapture: async () => {} }; },
  };
  const quality = new BrowserQualityController({ mode: 'reading', video: '720p30' });
  const capture = new BrowserCapture(crypto.randomUUID(), quality, () => {}, () => metadata++, () => {}, error => { throw error; }, native);
  try {
    await capture.start(); assert.deepEqual(sources, []); assert.equal(metadata, 1);
    stale = false; capture.requestRefresh(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sources, ['window:2']);
  } finally { capture.stop(); }
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

test('motion bitrate follows the selected quality and preserves saved settings without the new preference', () => {
  const quality = new BrowserQualityController({ mode: 'video', video: '1080p60' });
  assert.equal(validBrowserQuality(quality.settings), true);
  assert.equal(browserVideoBitrate(quality.quality, undefined), 8_000_000);
  assert.equal(browserVideoBitrate(quality.quality, 'balanced'), 4_000_000);
  for (let now = 0; now <= 23000; now += 100) quality.sample(5, now);
  assert.equal(quality.quality.fps, 60);
  assert.equal(browserVideoBitrate(quality.quality, 'high'), 20_000_000);
  quality.configure({ mode: 'reading', video: '1080p60', bitrate: 'high' });
  assert.equal(browserVideoBitrate(quality.quality, 'high'), 3_000_000);
  assert.equal(validBrowserQuality({ mode: 'video', video: '1080p30', bitrate: 'unbounded' }), false);
});

test('a local media relay preserves source quality hints and never takes ownership of capture tracks', async () => {
  const previous = globalThis.RTCPeerConnection; let encodingChanges = 0;
  class Connection {
    senders: unknown[] = []; localDescription: { toJSON(): unknown } | null = null;
    addTrack(track: unknown) { this.senders.push({ track, getParameters: () => ({ encodings: [{}] }), setParameters: async () => { encodingChanges++; } }); }
    getSenders() { return this.senders; }
    async createOffer() { return { type: 'offer', sdp: 'local-fixture' }; }
    async setLocalDescription(value: unknown) { this.localDescription = { toJSON: () => value }; }
    close() {}
  }
  globalThis.RTCPeerConnection = Connection as unknown as typeof RTCPeerConnection;
  const track = new MockMediaStreamTrack('video'); const stream = new MockMediaStream([track]);
  track.contentHint = 'motion';
  const media = new BrowserMedia(crypto.randomUUID(), true, async () => {}, () => {}, () => {}, () => {}, () => ({ iceServers: [] }));
  try {
    media.relay(stream as unknown as MediaStream); assert.equal(media.stream, stream);
    await media.offer('external'); assert.equal(track.contentHint, 'motion'); assert.equal(encodingChanges, 0);
    media.stop(); assert.equal(track.readyState, 'live'); assert.equal(media.stream, null);
  } finally { media.stop(); globalThis.RTCPeerConnection = previous; }
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
    receiver = { track: { kind: 'video' }, jitterBufferTarget: 100, playoutDelayHint: .1 };
    candidates: unknown[] = [];
    constructor(configuration: unknown) { this.configuration = configuration; created.push(this); }
    async setRemoteDescription(value: unknown) { this.remoteDescription = value; }
    async createAnswer() { return { type: 'answer', sdp: 'test-answer' }; }
    async setLocalDescription(value: unknown) {
      this.localDescription = { toJSON: () => value };
      this.onicecandidate?.({ candidate: { toJSON: () => ({candidate:'test-local-candidate'}) } });
    }
    async addIceCandidate(value: unknown) { this.candidates.push(value); }
    getReceivers() { return [this.receiver]; }
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
    assert.equal(created[0].receiver.jitterBufferTarget, 20);
    assert.equal(created[0].receiver.playoutDelayHint, .02);
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
