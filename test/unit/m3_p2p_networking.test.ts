import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SignalingManager } from '../../src/p2p/signaling_manager.ts';
import { MediaCoordinator } from '../../src/p2p/media_coordinator.ts';
import { PeerTracker } from '../../src/p2p/peer_tracker.ts';
import {
  sanitizeTurnUrl,
  buildIceServers,
  buildRtcConfiguration,
  formatJoinError,
  DEFAULT_STUN_SERVERS,
} from '../../src/p2p/ice_config.ts';
import {
  MockMediaStream,
  MockMediaStreamTrack,
} from '../helpers/browser_mocks.ts';

describe('M3 Unit Tests: Robust P2P Networking & Signaling Failover', () => {
  describe('1. Multi-Transport Failover State Machine (SignalingManager)', () => {
    it('should initialize with primary transport mqtt and 3 available transports', () => {
      const manager = new SignalingManager();
      assert.equal(manager.getActiveTransport(), 'mqtt');
      assert.deepEqual(manager.getAvailableTransports(), ['mqtt', 'nostr', 'torrent']);
      assert.equal(manager.failoverHistory.length, 0);
    });

    it('should cycle through failover transitions: mqtt -> nostr -> torrent -> mqtt', () => {
      const manager = new SignalingManager();

      // Failover 1: mqtt -> nostr
      const t1 = manager.recordWatchdogFailure('mqtt_socket_closed');
      assert.equal(t1, 'nostr');
      assert.equal(manager.getActiveTransport(), 'nostr');

      // Failover 2: nostr -> torrent
      const t2 = manager.recordWatchdogFailure('nostr_timeout');
      assert.equal(t2, 'torrent');
      assert.equal(manager.getActiveTransport(), 'torrent');

      // Failover 3: torrent -> mqtt
      const t3 = manager.recordWatchdogFailure('torrent_unreachable');
      assert.equal(t3, 'mqtt');
      assert.equal(manager.getActiveTransport(), 'mqtt');

      assert.equal(manager.failoverHistory.length, 3);
      assert.equal(manager.failoverHistory[0]!.from, 'mqtt');
      assert.equal(manager.failoverHistory[0]!.to, 'nostr');
      assert.equal(manager.failoverHistory[1]!.from, 'nostr');
      assert.equal(manager.failoverHistory[1]!.to, 'torrent');
      assert.equal(manager.failoverHistory[2]!.from, 'torrent');
      assert.equal(manager.failoverHistory[2]!.to, 'mqtt');
    });

    it('should emit failover events to registered listeners', () => {
      const manager = new SignalingManager();
      const events: any[] = [];
      const unsub = manager.onFailover((ev) => events.push(ev));

      manager.recordWatchdogFailure('test_reason');
      assert.equal(events.length, 1);
      assert.equal(events[0].from, 'mqtt');
      assert.equal(events[0].to, 'nostr');
      assert.equal(events[0].reason, 'test_reason');

      unsub();
      manager.recordWatchdogFailure('second_reason');
      assert.equal(events.length, 1, 'Unsubscribed listener must not receive further events');
    });

    it('should switch transport manually and reject invalid transports', async () => {
      const manager = new SignalingManager();
      const switchedToNostr = await manager.switchTransport('nostr');
      assert.equal(switchedToNostr, true);
      assert.equal(manager.getActiveTransport(), 'nostr');

      // Switching to same transport should return false
      const switchedAgain = await manager.switchTransport('nostr');
      assert.equal(switchedAgain, false);

      // Switching to invalid transport should return false
      const switchedInvalid = await manager.switchTransport('invalid_transport' as any);
      assert.equal(switchedInvalid, false);
      assert.equal(manager.getActiveTransport(), 'nostr');
    });

    it('should return detailed status info', () => {
      const manager = new SignalingManager();
      const detailed = manager.getDetailedStatus();
      assert.equal(detailed.activeTransport, 'mqtt');
      assert.equal(typeof detailed.connectedRelays, 'number');
      assert.equal(typeof detailed.totalRelays, 'number');
      assert.equal(detailed.isFailingOver, false);
    });
  });

  describe('2. Targeted Stream Dispatch & Recovery Protocol (MediaCoordinator)', () => {
    it('targetedAddStream should strictly pass { target: peerId } options object', () => {
      const capturedArgs: any[] = [];
      const mockRoom = {
        addStream: (stream: any, options: any) => {
          capturedArgs.push({ stream, options });
          return [Promise.resolve()];
        },
      };

      const mockStream = new MockMediaStream('test-stream') as unknown as MediaStream;
      const targetPeerId = 'target-peer-123';

      MediaCoordinator.targetedAddStream(mockRoom, mockStream, targetPeerId);

      assert.equal(capturedArgs.length, 1);
      assert.equal(capturedArgs[0].stream, mockStream);
      // Critical check: options must be an object with target property, NOT a string!
      assert.equal(typeof capturedArgs[0].options, 'object');
      assert.notEqual(typeof capturedArgs[0].options, 'string');
      assert.deepEqual(capturedArgs[0].options, { target: targetPeerId });
    });

    it('broadcastStream should call targetedAddStream for each target peer', () => {
      const targetedCalls: string[] = [];
      const mockRoom = {
        addStream: (_stream: any, options: any) => {
          if (options?.target) {
            targetedCalls.push(options.target);
          }
          return [Promise.resolve()];
        },
      };

      const mockStream = new MockMediaStream('test-stream') as unknown as MediaStream;
      const targets = ['peer-A', 'peer-B', 'peer-C'];

      MediaCoordinator.broadcastStream(mockRoom, mockStream, targets);

      assert.equal(targetedCalls.length, 3);
      assert.deepEqual(targetedCalls, ['peer-A', 'peer-B', 'peer-C']);
    });

    it('buildStreamStatusPayload should correctly map stream metadata', () => {
      const mockStream = new MockMediaStream('stream-abc');
      mockStream.addTrack(new MockMediaStreamTrack('video'));
      mockStream.addTrack(new MockMediaStreamTrack('audio'));

      const payload = MediaCoordinator.buildStreamStatusPayload(
        mockStream as unknown as MediaStream,
        true,
        'Alice'
      );

      assert.equal(payload.isStreaming, true);
      assert.equal(payload.senderName, 'Alice');
      assert.equal(payload.streamId, 'stream-abc');
      assert.equal(payload.hasAudio, true);
      assert.ok(payload.timestamp > 0);

      const stoppedPayload = MediaCoordinator.buildStreamStatusPayload(null, false, 'Alice');
      assert.equal(stoppedPayload.isStreaming, false);
      assert.equal(stoppedPayload.streamId, undefined);
    });

    it('shouldRequestStreamRecovery should detect track ending and streamId mismatch', () => {
      // 1. No active stream on viewer -> recovery needed
      const statusActive: any = { isStreaming: true, streamId: 'stream-101' };
      assert.equal(MediaCoordinator.shouldRequestStreamRecovery(null, statusActive), true);

      // 2. Viewer has active stream with live track and matching id -> no recovery needed
      const liveStream = new MockMediaStream('stream-101');
      const liveTrack = new MockMediaStreamTrack('video');
      liveTrack.readyState = 'live';
      liveStream.addTrack(liveTrack);
      assert.equal(
        MediaCoordinator.shouldRequestStreamRecovery(liveStream as unknown as MediaStream, statusActive),
        false
      );

      // 3. Screen share toggle scenario: Viewer stream track ended (readyState: 'ended') -> recovery needed!
      liveTrack.readyState = 'ended';
      assert.equal(
        MediaCoordinator.shouldRequestStreamRecovery(liveStream as unknown as MediaStream, statusActive),
        true
      );

      // 4. Broadcaster restarted with new streamId ('stream-102') -> recovery needed!
      const activeDifferentStream = new MockMediaStream('stream-old');
      const activeTrack = new MockMediaStreamTrack('video');
      activeTrack.readyState = 'live';
      activeDifferentStream.addTrack(activeTrack);
      const statusNewStream: any = { isStreaming: true, streamId: 'stream-102' };
      assert.equal(
        MediaCoordinator.shouldRequestStreamRecovery(activeDifferentStream as unknown as MediaStream, statusNewStream),
        true
      );

      // 5. Broadcaster is not streaming -> no recovery needed
      const statusInactive: any = { isStreaming: false };
      assert.equal(
        MediaCoordinator.shouldRequestStreamRecovery(null, statusInactive),
        false
      );
    });
  });

  describe('3. Verified Direct Peer Tracking & Ghost Peer Elimination (PeerTracker)', () => {
    it('should verify direct WebRTC peers and quarantine PEX rumors', () => {
      const tracker = new PeerTracker();

      // Direct WebRTC connection
      const verified = tracker.receivePeerExchange('peer-direct', true, 'Alice');
      assert.equal(verified, true);
      assert.equal(tracker.isVerified('peer-direct'), true);
      assert.equal(tracker.hasPeer('peer-direct'), true);
      assert.equal(tracker.getUsername('peer-direct'), 'Alice');
      assert.equal(tracker.unverifiedRumors.has('peer-direct'), false);

      // PEX Gossip Rumor
      const rumor = tracker.receivePeerExchange('peer-rumor', false, 'Bob');
      assert.equal(rumor, false);
      assert.equal(tracker.isVerified('peer-rumor'), false);
      assert.equal(tracker.hasPeer('peer-rumor'), false);
      assert.equal(tracker.unverifiedRumors.has('peer-rumor'), true);

      // Verified peers list must NOT contain the rumor
      const verifiedList = tracker.getVerifiedPeers();
      assert.equal(verifiedList.length, 1);
      assert.equal(verifiedList[0]!.id, 'peer-direct');
    });

    it('should promote quarantined rumor to verified once direct WebRTC handshake occurs', () => {
      const tracker = new PeerTracker();
      tracker.receivePeerExchange('peer-promoted', false, 'Charlie');
      assert.equal(tracker.unverifiedRumors.has('peer-promoted'), true);
      assert.equal(tracker.directConnectedPeers.has('peer-promoted'), false);

      // Direct WebRTC handshake succeeds
      const promoted = tracker.receivePeerExchange('peer-promoted', true);
      assert.equal(promoted, true);
      assert.equal(tracker.unverifiedRumors.has('peer-promoted'), false);
      assert.equal(tracker.directConnectedPeers.has('peer-promoted'), true);
      assert.equal(tracker.getVerifiedPeers().length, 1);
    });

    it('peerDisconnected should immediately purge peer from all maps and watchers', () => {
      const tracker = new PeerTracker();
      tracker.addPeer('peer-departed', 'Dave');
      tracker.addWatcher('peer-host', 'peer-departed', 'Dave');

      assert.equal(tracker.hasPeer('peer-departed'), true);
      assert.equal(tracker.getWatchers('peer-host').length, 1);

      const username = tracker.peerDisconnected('peer-departed');
      assert.equal(username, 'Dave');
      assert.equal(tracker.hasPeer('peer-departed'), false);
      assert.equal(tracker.directConnectedPeers.has('peer-departed'), false);
      assert.equal(tracker.getWatchers('peer-host').length, 0);
    });

    it('pruneStalePeers should purge peers missing heartbeats for > 6000ms', () => {
      const tracker = new PeerTracker();
      tracker.addPeer('peer-alive', 'Alive');
      tracker.addPeer('peer-stale', 'Stale');

      // Artificially age peer-stale
      (tracker as any).peerLastSeen.set('peer-stale', Date.now() - 7000);

      const pruned = tracker.pruneStalePeers(6000);
      assert.equal(pruned.length, 1);
      assert.equal(pruned[0], 'peer-stale');
      assert.equal(tracker.hasPeer('peer-stale'), false);
      assert.equal(tracker.hasPeer('peer-alive'), true);
    });

    it('isHost should execute deterministic leader election', () => {
      const tracker = new PeerTracker();
      const selfId = 'peer-me';

      // 1. Local user is room creator -> always host
      assert.equal(tracker.isHost(selfId, 1000, true), true);

      // 2. Local user is not creator, but creator is present in room -> not host
      tracker.addPeer('peer-creator', 'Boss', true, 500);
      assert.equal(tracker.isHost(selfId, 1000, false), false);

      // 3. Creator leaves -> lowest joinedAt becomes host
      tracker.removePeer('peer-creator');
      tracker.addPeer('peer-older', 'Senior', false, 800);
      // Older peer joined at 800 < self joined at 1000
      assert.equal(tracker.isHost(selfId, 1000, false), false);

      // If self joined earlier (e.g. 700 < 800) -> self becomes host!
      assert.equal(tracker.isHost(selfId, 700, false), true);
    });
  });

  describe('4. ICE Configuration & Diagnostics (ice_config)', () => {
    it('sanitizeTurnUrl should prepend turn: when protocol prefix is omitted', () => {
      assert.equal(sanitizeTurnUrl('relay.example.com:3478'), 'turn:relay.example.com:3478');
      assert.equal(sanitizeTurnUrl('turn:relay.example.com:3478'), 'turn:relay.example.com:3478');
      assert.equal(sanitizeTurnUrl('turns:relay.example.com:5349'), 'turns:relay.example.com:5349');
      assert.equal(sanitizeTurnUrl('   '), '');
    });

    it('buildIceServers should combine default STUN and custom TURN configurations', () => {
      const turnConfig = {
        enabled: true,
        url: 'turns:custom-turn.net:5349',
        username: 'user1',
        credential: 'secret-password',
      };

      const servers = buildIceServers(turnConfig);
      assert.equal(servers.length, 2);
      assert.deepEqual(servers[0]!.urls, DEFAULT_STUN_SERVERS);
      assert.deepEqual(servers[1]!.urls, ['turns:custom-turn.net:5349']);
      assert.equal(servers[1]!.username, 'user1');
      assert.equal(servers[1]!.credential, 'secret-password');
    });

    it('uses UDP and TCP TURN routes with one credential set', () => {
      const servers = buildIceServers({
        enabled: true,
        url: 'turn:relay.example:3478?transport=udp\nturn:relay.example:3478?transport=tcp',
        username: 'tester', credential: 'secret',
      });
      assert.deepEqual(servers[1]!.urls, [
        'turn:relay.example:3478?transport=udp',
        'turn:relay.example:3478?transport=tcp',
      ]);
    });

    it('buildRtcConfiguration should enforce relay-only policy when forceRelay is true', () => {
      const normalConfig = buildRtcConfiguration({ enabled: true, url: 'turn:relay.net:3478' });
      assert.equal(normalConfig.iceTransportPolicy, 'all');

      const forceRelayConfig = buildRtcConfiguration({ enabled: true, url: 'turn:relay.net:3478', forceRelay: true });
      assert.equal(forceRelayConfig.iceTransportPolicy, 'relay');
      assert.equal(forceRelayConfig.iceServers?.length, 1);
      assert.deepEqual(forceRelayConfig.iceServers?.[0]?.urls, ['turn:relay.net:3478']);

      const missingTurnConfig = buildRtcConfiguration({ enabled: false, url: 'turn:relay.net:3478', forceRelay: true });
      assert.equal(missingTurnConfig.iceTransportPolicy, 'all');
    });

    it('formatJoinError should translate SDP/TURN errors into actionable messages', () => {
      const turnUnreachableMsg = formatJoinError({
        error: 'could not connect to peer after exchanging SDP; check that your TURN server URLs and credentials are reachable',
        peerId: 'peer-abc12345',
      });
      assert.ok(turnUnreachableMsg.includes('nenhuma rota ICE foi estabelecida'));

      const symmetricNatMsg = formatJoinError({
        error: 'could not connect to peer after exchanging SDP; configure TURN servers with turnConfig',
        peerId: 'peer-xyz98765',
      });
      assert.ok(symmetricNatMsg.includes('NAT Simétrico'));
      assert.ok(symmetricNatMsg.includes('Configure um servidor TURN'));
    });
  });
});
