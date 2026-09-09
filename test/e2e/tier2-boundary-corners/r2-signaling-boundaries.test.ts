import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSignalingRoomIdOracle,
  generateUserColorOracle,
  SignalingFailoverMachine,
} from '../harness/signaling-oracle.ts';

describe('Tier 2: R2 Signaling Boundaries & Corner Cases', () => {
  it('R2-T2-1: Should handle whitespace-only password by treating it as public room', () => {
    const roomId = 'TestRoom';
    const whitespacePassword = '     ';
    const derived = computeSignalingRoomIdOracle(roomId, whitespacePassword);
    assert.equal(derived, 'public-testroom');
  });

  it('R2-T2-2: Should sanitize adversarial and XSS payloads in room names without crashing', () => {
    const maliciousNames = [
      '<script>alert(1)</script>',
      'DROP TABLE rooms;--',
      'room\x00with\x00nullbytes',
      '🔥🚀🎉_emoji_room_99',
      '../../../etc/passwd',
      '\\Windows\\System32\\cmd.exe',
    ];

    for (const rawName of maliciousNames) {
      const derived = computeSignalingRoomIdOracle(rawName, 'password123');
      assert.ok(derived.startsWith('sec-'), `Failed for ${rawName}`);
      assert.ok(derived.length > 5, 'Derived hash must have valid length');
      // Must not throw or crash
    }
  });

  it('R2-T2-3: Should handle extreme username length (10,000 characters) in color generator', () => {
    const extremeUsername = 'A'.repeat(10000);
    const color = generateUserColorOracle(extremeUsername);
    assert.ok(color.startsWith('hsl(') && color.endsWith(')'));
  });

  it('R2-T2-4: Should handle rapid churn of 100 peers joining and disconnecting', () => {
    const machine = new SignalingFailoverMachine();
    machine.connect('mqtt');

    // 100 peers join
    for (let i = 0; i < 100; i++) {
      machine.receivePeerExchange(`peer-${i}`, true);
    }
    assert.equal(machine.directConnectedPeers.size, 100);

    // 100 peers leave
    for (let i = 0; i < 100; i++) {
      machine.peerDisconnected(`peer-${i}`);
    }
    assert.equal(machine.directConnectedPeers.size, 0);
  });

  it('R2-T2-5: Should handle duplicate peer join events idempotently', () => {
    const machine = new SignalingFailoverMachine();
    machine.connect('mqtt');

    machine.receivePeerExchange('peer-duplicate', true);
    machine.receivePeerExchange('peer-duplicate', true);
    machine.receivePeerExchange('peer-duplicate', true);

    assert.equal(machine.directConnectedPeers.size, 1);
  });

  it('R2-T2-6: Should cycle through transports cleanly during sustained failure loops', () => {
    const machine = new SignalingFailoverMachine();
    machine.connect('mqtt');

    // Cycle through failovers 12 times (4 full loops across [mqtt, nostr, torrent])
    for (let i = 0; i < 12; i++) {
      machine.recordWatchdogFailure();
    }

    assert.equal(machine.failoverHistory.length, 12);
    // After 12 shifts, it should return to original transport 'mqtt'
    assert.equal(machine.currentTransport, 'mqtt');
  });

  it('R2-T2-7: Should prevent unverified PEX rumors from being tracked as connected peers', () => {
    const machine = new SignalingFailoverMachine();
    machine.connect('mqtt');

    // Add 10 unverified rumors
    for (let i = 0; i < 10; i++) {
      machine.receivePeerExchange(`rumor-peer-${i}`, false);
    }

    assert.equal(machine.directConnectedPeers.size, 0, 'No direct WebRTC peer should be connected');
    assert.equal(machine.unverifiedRumors.size, 10, 'All 10 must be held in unverified rumors set');

    const status = machine.getStatus();
    assert.equal(status.connectedPeers.length, 0);
  });
});
