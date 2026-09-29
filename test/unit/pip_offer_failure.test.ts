import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PipService } from '../../src/services/pip_service.ts';

test('a rejected PiP offer does not recurse and ignores same-window signals', async () => {
  const previousPc = globalThis.RTCPeerConnection;
  let offerAttempts = 0;
  let candidateAttempts = 0;
  class MockPeerConnection {
    signalingState = 'stable';
    iceConnectionState = 'new';
    remoteDescription = null;
    onicecandidate: ((event: any) => void) | null = null;
    getSenders() { return []; }
    addTrack() { return {}; }
    createOffer() { offerAttempts++; return Promise.resolve({ type: 'offer', sdp: 'invalid' }); }
    setLocalDescription() { return Promise.reject(new Error('Invalid SDP line')); }
    addIceCandidate() { candidateAttempts++; return Promise.resolve(); }
    close() {}
  }
  (globalThis as any).RTCPeerConnection = MockPeerConnection;
  const track = { kind: 'video', readyState: 'live' };
  const stream = {
    getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [],
  } as unknown as MediaStream;
  const peerId = `pip-offer-test-${Date.now()}`;
  const service = new PipService();
  const viewChannel = new BroadcastChannel(`p2sharer-pip-${peerId}`);
  try {
    await service.openPip(peerId, 'Test', stream);
    viewChannel.postMessage({ type: 'candidate', sender: 'main', candidate: { candidate: 'self' } });
    viewChannel.postMessage({ type: 'pip-ready', sender: 'pip' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(candidateAttempts, 0, 'the main window must ignore its own ICE candidate');
    assert.equal(offerAttempts, 1, 'failed SDP must not trigger unbounded immediate retries');
  } finally {
    viewChannel.close();
    await service.restoreFromPip(peerId);
    service.destroy();
    (globalThis as any).RTCPeerConnection = previousPc;
  }
});
