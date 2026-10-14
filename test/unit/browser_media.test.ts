import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserMedia } from '../../src/apps/browser_media.ts';
import { MockMediaStream, MockMediaStreamTrack } from '../helpers/browser_mocks.ts';

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
