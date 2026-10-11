import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachIceDiagnostics, formatJoinError, summarizeIceDescription, summarizeIceStats } from '../../src/p2p/ice_config.ts';
import { classifyIceAddress, createIceAddressFingerprinter } from '../../src/core/ice_address_diagnostics.ts';

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
  context.mock.timers.tick(7000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(warnings.length, 2);
  connection.connectionState = 'connected';
  connection.dispatchEvent(new Event('connectionstatechange'));
  connection.dispatchEvent(new Event('connectionstatechange'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(connected.length, 1);
  assert.equal((connected[0][1] as { id: number }).id, pending.id);
  context.mock.timers.tick(20000);
  assert.equal(warnings.length, 2);
});

test('route summaries preserve selected checks and DTLS while redacting candidate identities and addresses', () => {
  const reports = [
    { id: 'local-private', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp', address: '192.0.2.1', port: 12345, url: 'turn:fixture.invalid', username: 'private-user' },
    { id: 'remote-private', type: 'remote-candidate', candidateType: 'prflx', protocol: 'udp', address: '2001:db8::1' },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `pair-${i}`, type: 'candidate-pair', state: 'waiting' })),
    { id: 'selected-private', type: 'candidate-pair', localCandidateId: 'local-private', remoteCandidateId: 'remote-private', state: 'succeeded', nominated: true,
      requestsSent: 5, responsesReceived: 4, requestsReceived: 3, responsesSent: 3, currentRoundTripTime: 0.05 },
    { id: 'transport-private', type: 'transport', selectedCandidatePairId: 'selected-private', dtlsState: 'connected', iceRole: 'controlling', localCertificateId: 'private-cert' },
  ];
  const summary = summarizeIceStats(new Map(reports.map(report => [report.id, report])) as unknown as RTCStatsReport);
  assert.equal(summary.schema, 2);
  assert.equal(summary.pairCount, 31);
  assert.equal(summary.omittedPairs, 7);
  assert.equal(summary.pairs.length, 24);
  assert.equal(summary.pairs[0].selected, true);
  assert.equal(summary.pairs[0].responsesReceived, 4);
  assert.equal(summary.pairs[0].local?.family, 'ipv4');
  assert.equal(summary.pairs[0].remote?.family, 'ipv6');
  assert.equal(summary.candidates.remote.prflx, 1);
  assert.equal(summary.totals.requestsSent, 5);
  assert.equal(summary.totals.consentRequestsSent, undefined);
  assert.deepEqual(summary.transports, [{ dtls: 'connected', iceRole: 'controlling' }]);
  const serialized = JSON.stringify(summary);
  for (const value of ['local-private', 'remote-private', 'selected-private', '192.0.2.1', '2001:db8::1', '12345', 'fixture.invalid', 'private-user', 'private-cert'])
    assert.ok(!serialized.includes(value));
});

test('ICE address classification distinguishes IPv6 tunnels, local scopes and malformed candidates', () => {
  // Build synthetic prefix fixtures, as in the repository hygiene tests; these are not deployment addresses.
  const v6 = (...segments: string[]) => segments.join(':');
  for (const [address, scope] of [
    ['2001:db8::1', 'ipv6-global'], [v6('2001', '0', '', '1'), 'ipv6-teredo'], [v6('2002', 'c000', '201', '', '1'), 'ipv6-6to4'],
    [v6('fe80', '', '1'), 'ipv6-link-local'], [v6('fd00', '', '1'), 'ipv6-ula'], ['::ffff:192.0.2.1', 'ipv4-mapped'],
    ['::1', 'loopback'], ['::', 'unspecified'], [[10, 0, 0, 1].join('.'), 'ipv4-private'],
    [[100, 64, 0, 1].join('.'), 'ipv4-shared'], ['fixture.local', 'mdns'], ['2001:::1', 'unknown'],
    ['999.1.1.1', 'unknown'], ['fixture.invalid', 'unknown'],
  ]) assert.equal(classifyIceAddress(address).scope, scope, address);
  assert.equal(classifyIceAddress(undefined).scope, 'unavailable');
});

test('protected candidate identities survive app restarts and distinguish address, prefix and endpoint changes', async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const first = createIceAddressFingerprinter(storage);
  const original = await first('2001:db8:1:2::1', 12345, 'udp');
  assert.equal(original.identityScope, 'profile');
  const restarted = await createIceAddressFingerprinter(storage)('2001:0db8:0001:0002:0:0:0:1', 12345, 'udp');
  assert.deepEqual(restarted, original);
  const newPort = await first('2001:db8:1:2::1', 23456, 'udp');
  assert.equal(newPort.addressToken, original.addressToken);
  assert.equal(newPort.prefixToken, original.prefixToken);
  assert.notEqual(newPort.endpointToken, original.endpointToken);
  const temporaryAddress = await first('2001:db8:1:2::2', 12345, 'udp');
  assert.notEqual(temporaryAddress.addressToken, original.addressToken);
  assert.equal(temporaryAddress.prefixToken, original.prefixToken);
  const newPrefix = await first('2001:db8:1:3::1', 12345, 'udp');
  assert.notEqual(newPrefix.prefixToken, original.prefixToken);
  const otherProfile = await createIceAddressFingerprinter()('2001:db8:1:2::1', 12345, 'udp');
  assert.equal(otherProfile.identityScope, 'process');
  assert.notEqual(otherProfile.addressToken, original.addressToken);
  assert.notEqual(otherProfile.identityKey, original.identityKey);
  const serialized = JSON.stringify([original, restarted, newPort, temporaryAddress, newPrefix]);
  for (const value of ['2001:db8', '12345', '23456', ...values.values()]) assert.ok(!serialized.includes(value));
  const unavailable = await first('fixture.local');
  assert.equal(unavailable.addressToken, null);
  assert.equal(unavailable.endpointToken, null);
});

test('route groups retain IPv6 checks even when IPv4 checks fill the bounded pair list', () => {
  const reports = [
    { id: 'v4', type: 'local-candidate', candidateType: 'host', address: '192.0.2.1' },
    { id: 'v6', type: 'remote-candidate', candidateType: 'host', address: ['2001', '0', '', '1'].join(':') },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `v4-${i}`, type: 'candidate-pair', localCandidateId: 'v4', remoteCandidateId: 'v4', requestsSent: 10, responsesReceived: 0 })),
    { id: 'v6-check', type: 'candidate-pair', localCandidateId: 'v6', remoteCandidateId: 'v6', requestsSent: 2, responsesReceived: 0 },
  ];
  const summary = summarizeIceStats(new Map(reports.map(report => [report.id, report])) as unknown as RTCStatsReport);
  assert.equal(summary.pairs.length, 24);
  assert.ok(summary.pairs.every(pair => pair.local?.family === 'ipv4'));
  assert.deepEqual(summary.routeGroups.find(group => group.route === 'ipv6-teredo->ipv6-teredo'),
    { route: 'ipv6-teredo->ipv6-teredo', pairCount: 1, requestsSent: 2, responsesReceived: 0 });
  assert.equal(summary.candidateInventory.length, 2);
  assert.equal(summary.omittedCandidates, 0);
});

test('connected lifecycle records protected candidate inventory without logging addresses or ports', { timeout: 5000 }, async context => {
  let receive!: (value: unknown) => void;
  const logged = new Promise<unknown>(resolve => { receive = resolve; });
  context.mock.method(console, 'log', (_message: unknown, value: unknown) => receive(value));
  class Connection extends EventTarget {
    signalingState = 'stable'; connectionState = 'connected'; iceConnectionState = 'connected'; iceGatheringState = 'complete';
    localDescription = description(); remoteDescription = description();
    async getStats() { return new Map([['local', { id: 'local', type: 'local-candidate', candidateType: 'host',
      address: '2001:db8::1', port: 12345, protocol: 'udp' }]]); }
  }
  const connection = new Connection();
  attachIceDiagnostics(connection as unknown as RTCPeerConnection);
  connection.dispatchEvent(new Event('connectionstatechange'));
  const summary = await logged as { routes: { candidateInventory: Array<{ scope: string; addressToken: string; prefixToken: string; endpointToken: string }> } };
  const candidate = summary.routes.candidateInventory[0];
  assert.equal(candidate.scope, 'ipv6-global');
  for (const token of [candidate.addressToken, candidate.prefixToken, candidate.endpointToken]) assert.match(token, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(summary).includes('2001:db8'));
  assert.ok(!JSON.stringify(summary).includes('12345'));
});

test('stats collection stops waiting after one second without inventing empty route measurements', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const logs: unknown[][] = [];
  context.mock.method(console, 'log', (...args: unknown[]) => logs.push(args));
  class Connection extends EventTarget {
    signalingState = 'stable'; connectionState = 'connected'; iceConnectionState = 'connected'; iceGatheringState = 'complete';
    localDescription = description(); remoteDescription = description();
    getStats() { return new Promise<RTCStatsReport>(() => {}); }
  }
  const connection = new Connection();
  attachIceDiagnostics(connection as unknown as RTCPeerConnection);
  connection.dispatchEvent(new Event('connectionstatechange'));
  context.mock.timers.tick(1000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(logs.length, 1);
  assert.deepEqual((logs[0][1] as { routes: unknown }).routes, { status: 'timeout' });
});

test('unavailable stats are explicit and successful connections cancel pending route samples', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const logs: unknown[][] = [];
  context.mock.method(console, 'log', (...args: unknown[]) => logs.push(args));
  context.mock.method(console, 'warn', (...args: unknown[]) => logs.push(args));
  class Connection extends EventTarget {
    signalingState = 'stable'; connectionState = 'new'; iceConnectionState = 'new'; iceGatheringState = 'new';
    localDescription = description(); remoteDescription = description();
    async getStats() { throw new Error('private error'); }
  }
  const connection = new Connection();
  attachIceDiagnostics(connection as unknown as RTCPeerConnection);
  connection.dispatchEvent(new Event('signalingstatechange'));
  connection.connectionState = 'connected';
  connection.dispatchEvent(new Event('connectionstatechange'));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(logs.length, 1);
  assert.deepEqual((logs[0][1] as { routes: unknown }).routes, { status: 'unavailable' });
  assert.ok(!JSON.stringify(logs).includes('private error'));
  context.mock.timers.tick(20000);
  assert.equal(logs.length, 1);
});
