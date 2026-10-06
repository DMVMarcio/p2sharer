import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticOpaqueId, diagnosticPeerSnapshot, startMediaDiagnostics } from '../../src/core/media_diagnostics.ts';

test('diagnostic RTP snapshots retain counters while excluding source identifiers and addresses', async () => {
  const pc = {
    connectionState: 'connected', iceConnectionState: 'completed', signalingState: 'stable',
    getStats: async () => new Map([
      ['video', { id: 'raw-report', type: 'inbound-rtp', kind: 'video', trackIdentifier: 'raw-track',
        framesDecoded: 120, jitter: 0.005, frameWidth: 1920, frameHeight: 1080, ssrc: 42,
        powerEfficientDecoder: true, bytesReceived: NaN, address: 'private-address', sdp: 'private-sdp' }],
      ['candidate', { id: 'raw-candidate', type: 'candidate-pair', nominated: true,
        currentRoundTripTime: 0.02, availableOutgoingBitrate: 15_000_000, url: 'private-url' }],
      ['unused', { id: 'unused-pair', type: 'candidate-pair', nominated: false, bytesSent: 99 }],
    ]),
  } as unknown as RTCPeerConnection;
  const result = await diagnosticPeerSnapshot(pc, 1);
  const records = result.peers as Array<Record<string, unknown>>;
  assert.equal(records.length, 2);
  assert.equal(records[0].framesDecoded, 120);
  assert.equal(records[0].track, diagnosticOpaqueId('raw-track'));
  assert.equal(records[0].ssrc, 42);
  assert.equal(records[0].powerEfficientDecoder, true);
  assert.equal(records[1].currentRoundTripTime, 0.02);
  assert.equal('bytesReceived' in records[0], false);
  const serialized = JSON.stringify(result);
  for (const value of ['raw-report', 'raw-track', 'private-address', 'private-sdp', 'private-url', 'unused-pair']) {
    assert.equal(serialized.includes(value), false);
  }
});

test('failed getStats remains a numeric state record without the raw error', async () => {
  const pc = { connectionState: 'failed', iceConnectionState: 'failed', signalingState: 'stable',
    getStats: async () => { throw new Error('private-address'); } } as unknown as RTCPeerConnection;
  assert.deepEqual(await diagnosticPeerSnapshot(pc, 7), { id: 7, state: 4, ice: 5, signaling: 0, failed: true });
});

test('diagnostics stay inactive outside Tauri and opaque hashes use the native FNV convention', async () => {
  assert.equal(await startMediaDiagnostics(), false);
  assert.equal(diagnosticOpaqueId('hello'), 1335831723);
});
