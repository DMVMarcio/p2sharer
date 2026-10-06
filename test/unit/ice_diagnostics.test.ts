import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachIceDiagnostics, formatJoinError, summarizeIceDescription } from '../../src/p2p/ice_config.ts';

// Documentation-only addresses and intentionally fake credentials exercise redaction.
const description = (port = '9') => ({ type: 'offer', sdp: [
  'v=0', `m=application ${port} UDP/DTLS/SCTP webrtc-datachannel`,
  'a=ice-ufrag:fixture-ufrag', 'a=ice-pwd:fixture-password', 'a=fingerprint:sha-256 fixture-fingerprint',
  'a=candidate:fixture 1 udp 1 192.0.2.1 12345 typ host',
  'a=candidate:fixture 1 udp 1 fixture.local 12345 typ host',
].join('\r\n') } as RTCSessionDescription);

test('SDP summaries distinguish missing and zero-port media without exposing SDP or credentials', () => {
  assert.equal(summarizeIceDescription(null), null);
  const summary = summarizeIceDescription(description('0'))!;
  assert.deepEqual(summary.media, [{ kind: 'application', zeroPort: true, bundleOnly: false }]);
  assert.equal(summary.candidateLines, 2);
  assert.equal(summary.mdnsCandidateLines, 1);
  assert.equal(summary.hasIceUfrag, true);
  assert.equal(summary.hasIcePwd, true);
  assert.equal(summary.hasFingerprint, true);
  const serialized = JSON.stringify(summary);
  for (const privateValue of ['192.0.2.1', 'fixture.local', 'fixture-ufrag', 'fixture-password', 'fixture-fingerprint'])
    assert.ok(!serialized.includes(privateValue));
  assert.deepEqual(summarizeIceDescription({ type: 'answer', sdp: 'v=0\r\n' } as RTCSessionDescription)?.media, []);
  const bundled = description('0');
  bundled.sdp += '\r\na=bundle-only';
  assert.equal(summarizeIceDescription(bundled)?.media[0].bundleOnly, true);
});

test('LAN timeout diagnostics never recommend TURN or assert symmetric NAT', () => {
  const error = 'could not connect after exchanging SDP; configure TURN servers';
  const message = formatJoinError({ error, peerId: 'fixture-peer' }, 'lan');
  assert.match(message, /LAN\/VPN/);
  assert.match(message, /peer: fixtur/);
  assert.ok(!/TURN|NAT/.test(message));
});

test('pending and successful attempts retain generated candidates independently of getStats', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const warnings: unknown[][] = [], connected: unknown[][] = [];
  context.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  context.mock.method(console, 'log', (...args: unknown[]) => { connected.push(args); });
  class Connection extends EventTarget {
    signalingState = 'stable'; connectionState = 'new'; iceConnectionState = 'new'; iceGatheringState = 'new';
    localDescription = description(); remoteDescription = description();
    async getStats() { return new Map(); }
  }
  const connection = new Connection();
  attachIceDiagnostics(connection as unknown as RTCPeerConnection, 'lan');
  connection.dispatchEvent(Object.assign(new Event('icecandidate'), {
    candidate: { candidate: 'candidate:fixture 1 udp 1 fixture.local 12345 typ host' },
  }));
  connection.dispatchEvent(new Event('signalingstatechange'));
  connection.dispatchEvent(new Event('signalingstatechange'));
  context.mock.timers.tick(5000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(warnings.length, 1);
  const pending = warnings[0][1] as { generated: { host: number; mdns: number }; mode: string; id: number };
  assert.equal(pending.mode, 'lan');
  assert.deepEqual(pending.generated, { host: 1, srflx: 0, relay: 0, mdns: 1 });
  connection.connectionState = 'connected';
  connection.dispatchEvent(new Event('connectionstatechange'));
  connection.dispatchEvent(new Event('connectionstatechange'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(connected.length, 1);
  assert.equal((connected[0][1] as { id: number }).id, pending.id);
});
