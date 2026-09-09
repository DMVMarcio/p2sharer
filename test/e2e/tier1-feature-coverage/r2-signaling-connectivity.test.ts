import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSignalingRoomIdOracle,
  validateRoomSlugFormat,
  generateUserColorOracle,
  SignalingFailoverMachine,
} from '../harness/signaling-oracle.ts';

describe('Tier 1: R2 Signaling & Connectivity Coverage', () => {
  it('R2-T1-1: Should derive public room ID with lowercase normalized prefix', () => {
    const rawRoom = '  My-Test-Room-123  ';
    const signalingId = computeSignalingRoomIdOracle(rawRoom);
    assert.equal(signalingId, 'public-my-test-room-123');
  });

  it('R2-T1-2: Should derive password-isolated cryptographic room ID', () => {
    const rawRoom = 'GamingRoom';
    const pass1 = 'Secret123!';
    const pass2 = 'DifferentPass';

    const id1 = computeSignalingRoomIdOracle(rawRoom, pass1);
    const id2 = computeSignalingRoomIdOracle(rawRoom, pass2);

    assert.ok(id1.startsWith('sec-gamingroom-'));
    assert.ok(id2.startsWith('sec-gamingroom-'));
    assert.notEqual(id1, id2, 'Identical room names with different passwords must produce distinct IDs');
  });

  it('R2-T1-3: Should validate random room slug conforms to grammar', () => {
    const validSlugs = ['cyber-falcon-101', 'neon-tiger-999', 'hyper-wolf-500'];
    for (const slug of validSlugs) {
      assert.equal(validateRoomSlugFormat(slug), true);
    }

    const invalidSlugs = ['bad-slug', 'cyber-unknownanimal-123', 'cyber-falcon-99'];
    for (const slug of invalidSlugs) {
      assert.equal(validateRoomSlugFormat(slug), false);
    }
  });

  it('R2-T1-4: Should generate deterministic user color in HSL format', () => {
    const color1 = generateUserColorOracle('Alice');
    const color2 = generateUserColorOracle('Alice');
    const color3 = generateUserColorOracle('Bob');

    assert.equal(color1, color2, 'Same username must produce identical color');
    assert.ok(color1.startsWith('hsl(') && color1.endsWith(')'));
    assert.notEqual(color1, color3, 'Distinct usernames should typically produce distinct colors');
  });

  it('R2-T1-5: Should verify direct WebRTC connected peers and filter unverified rumors', () => {
    const failoverMachine = new SignalingFailoverMachine();
    failoverMachine.connect('mqtt');

    // Peer A connects via direct WebRTC
    const isPeerAVerified = failoverMachine.receivePeerExchange('peer-A', true);
    assert.equal(isPeerAVerified, true);
    assert.ok(failoverMachine.directConnectedPeers.has('peer-A'));
    assert.equal(failoverMachine.unverifiedRumors.has('peer-A'), false);

    // Peer B arrives as a PEX gossip rumor (not yet connected via WebRTC)
    const isPeerBVerified = failoverMachine.receivePeerExchange('peer-B', false);
    assert.equal(isPeerBVerified, false);
    assert.equal(failoverMachine.directConnectedPeers.has('peer-B'), false);
    assert.ok(failoverMachine.unverifiedRumors.has('peer-B'));

    // Peer B completes WebRTC handshake
    const isPeerBNowVerified = failoverMachine.receivePeerExchange('peer-B', true);
    assert.equal(isPeerBNowVerified, true);
    assert.ok(failoverMachine.directConnectedPeers.has('peer-B'));
    assert.equal(failoverMachine.unverifiedRumors.has('peer-B'), false);
  });

  it('R2-T1-6: Should handle peer disconnect cleanly', () => {
    const failoverMachine = new SignalingFailoverMachine();
    failoverMachine.connect('mqtt');
    failoverMachine.receivePeerExchange('peer-A', true);
    assert.equal(failoverMachine.directConnectedPeers.size, 1);

    failoverMachine.peerDisconnected('peer-A');
    assert.equal(failoverMachine.directConnectedPeers.size, 0);
  });

  it('R2-T1-7: Should transition across signaling transports on watchdog failure', () => {
    const failoverMachine = new SignalingFailoverMachine();
    failoverMachine.connect('mqtt');
    assert.equal(failoverMachine.currentTransport, 'mqtt');

    // Transport 1 failure: MQTT -> Nostr
    const t1 = failoverMachine.recordWatchdogFailure();
    assert.equal(t1, 'nostr');
    assert.equal(failoverMachine.currentTransport, 'nostr');

    // Transport 2 failure: Nostr -> Torrent
    const t2 = failoverMachine.recordWatchdogFailure();
    assert.equal(t2, 'torrent');
    assert.equal(failoverMachine.currentTransport, 'torrent');

    assert.equal(failoverMachine.failoverHistory.length, 2);
  });
});
