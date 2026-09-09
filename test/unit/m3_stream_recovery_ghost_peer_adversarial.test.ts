import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MediaCoordinator } from '../../src/p2p/media_coordinator.ts';
import { PeerTracker } from '../../src/p2p/peer_tracker.ts';
import {
  MockMediaStream,
  MockMediaStreamTrack,
} from '../e2e/harness/dom-mock.ts';
import type { StreamStatusPayload } from '../../src/core/types.ts';

describe('M3 Adversarial Challenge: Stream Recovery Protocol & Ghost Peer Elimination', () => {
  describe('Challenge 1: Screen Share Toggle Recovery & Targeted Dispatch', () => {
    it('Empirical-1.1: shouldRequestStreamRecovery truth table under adversarial inputs', () => {
      // Rule 1: If incomingStatus.isStreaming is false, NEVER request recovery
      const inactiveStatus: StreamStatusPayload = {
        isStreaming: false,
        timestamp: Date.now(),
      };
      assert.equal(
        MediaCoordinator.shouldRequestStreamRecovery(null, inactiveStatus),
        false,
        'Must be false when incomingStatus is not streaming, even if currentStream is null'
      );
      assert.equal(
        MediaCoordinator.shouldRequestStreamRecovery(undefined, inactiveStatus),
        false,
        'Must be false when incomingStatus is not streaming, even if currentStream is undefined'
      );

      const activeStatus: StreamStatusPayload = {
        isStreaming: true,
        streamId: 'stream-alpha',
        timestamp: Date.now(),
      };

      // Rule 2: If currentStream is null or undefined and isStreaming is true -> MUST request recovery
      assert.equal(
        MediaCoordinator.shouldRequestStreamRecovery(null, activeStatus),
        true,
        'Must request recovery if currentStream is null'
      );
      assert.equal(
        MediaCoordinator.shouldRequestStreamRecovery(undefined, activeStatus),
        true,
        'Must request recovery if currentStream is undefined'
      );

      // Rule 3: If currentStream has no video tracks (e.g. audio-only glitch) -> MUST request recovery
      const audioOnlyStream = new MockMediaStream('stream-audio-only');
      audioOnlyStream.addTrack(new MockMediaStreamTrack('audio'));
      assert.equal(
        MediaCoordinator.shouldRequestStreamRecovery(
          audioOnlyStream as unknown as MediaStream,
          activeStatus
        ),
        true,
        'Must request recovery if stream lacks video tracks'
      );

      // Rule 4: If currentStream video track ended (readyState === "ended") -> MUST request recovery
      const endedStream = new MockMediaStream('stream-alpha');
      const endedTrack = new MockMediaStreamTrack('video');
      endedTrack.readyState = 'ended';
      endedStream.addTrack(endedTrack);
      assert.equal(
        MediaCoordinator.shouldRequestStreamRecovery(
          endedStream as unknown as MediaStream,
          activeStatus
        ),
        true,
        'Must request recovery when video track is ended'
      );

      // Rule 5: Multiple video tracks, all ended -> MUST request recovery
      const multiEndedStream = new MockMediaStream('stream-alpha');
      const t1 = new MockMediaStreamTrack('video');
      t1.readyState = 'ended';
      const t2 = new MockMediaStreamTrack('video');
      t2.readyState = 'ended';
      multiEndedStream.addTrack(t1);
      multiEndedStream.addTrack(t2);
      assert.equal(
        MediaCoordinator.shouldRequestStreamRecovery(
          multiEndedStream as unknown as MediaStream,
          activeStatus
        ),
        true,
        'Must request recovery when all video tracks are ended'
      );

      // Rule 6: Multiple tracks with at least one live track and matching streamId -> NO recovery
      const multiTracksStream = new MockMediaStream('stream-alpha');
      const liveTrack = new MockMediaStreamTrack('video');
      liveTrack.readyState = 'live';
      multiTracksStream.addTrack(t1);
      multiTracksStream.addTrack(liveTrack);
      assert.equal(
        MediaCoordinator.shouldRequestStreamRecovery(
          multiTracksStream as unknown as MediaStream,
          activeStatus
        ),
        false,
        'Must not request recovery when at least one video track is live and streamId matches'
      );

      // Rule 7: StreamId mismatch (Screen share toggle scenario: new stream generated) -> MUST request recovery!
      const oldStream = new MockMediaStream('stream-old-123');
      const oldLiveTrack = new MockMediaStreamTrack('video');
      oldLiveTrack.readyState = 'live';
      oldStream.addTrack(oldLiveTrack);
      assert.equal(
        MediaCoordinator.shouldRequestStreamRecovery(
          oldStream as unknown as MediaStream,
          activeStatus // streamId: 'stream-alpha'
        ),
        true,
        'Must request recovery when streamId changes upon screen toggle restart'
      );

      // Rule 8: Identical streamId and live track -> NO recovery needed
      const matchingStream = new MockMediaStream('stream-alpha');
      const matchingLiveTrack = new MockMediaStreamTrack('video');
      matchingLiveTrack.readyState = 'live';
      matchingStream.addTrack(matchingLiveTrack);
      assert.equal(
        MediaCoordinator.shouldRequestStreamRecovery(
          matchingStream as unknown as MediaStream,
          activeStatus
        ),
        false,
        'Must not request recovery when stream is already live with matching streamId'
      );
    });

    it('Empirical-1.2: targetedAddStream strictly isolates dispatch to target peer', () => {
      const peerCallLog: { peerId: string; options: any }[] = [];
      const mockRoom = {
        addStream: (_stream: any, options: any) => {
          peerCallLog.push({ peerId: options?.target, options });
          return [Promise.resolve()];
        },
      };

      const stream = new MockMediaStream('screen-share-stream') as unknown as MediaStream;

      // Dispatch to specific peer 'peer-alice'
      const res1 = MediaCoordinator.targetedAddStream(mockRoom, stream, 'peer-alice');
      assert.equal(res1.length, 1);
      assert.equal(peerCallLog.length, 1);
      assert.equal(peerCallLog[0]?.peerId, 'peer-alice');
      assert.deepEqual(peerCallLog[0]?.options, { target: 'peer-alice' });

      // Dispatch to another peer 'peer-bob'
      const res2 = MediaCoordinator.targetedAddStream(mockRoom, stream, 'peer-bob');
      assert.equal(res2.length, 1);
      assert.equal(peerCallLog.length, 2);
      assert.equal(peerCallLog[1]?.peerId, 'peer-bob');
      assert.deepEqual(peerCallLog[1]?.options, { target: 'peer-bob' });

      // Verify no broadcast occurred: options must NEVER be undefined, null, or string
      for (const call of peerCallLog) {
        assert.equal(typeof call.options, 'object');
        assert.notEqual(call.options, null);
        assert.ok('target' in call.options);
      }
    });

    it('Empirical-1.3: targetedAddStream boundary conditions and fault resilience', () => {
      const stream = new MockMediaStream('valid-stream') as unknown as MediaStream;
      const validRoom = {
        addStream: () => [Promise.resolve()],
      };

      // Null / undefined / empty arguments must fail gracefully without throwing
      assert.deepEqual(MediaCoordinator.targetedAddStream(null, stream, 'peer-1'), []);
      assert.deepEqual(MediaCoordinator.targetedAddStream(validRoom, null as any, 'peer-1'), []);
      assert.deepEqual(MediaCoordinator.targetedAddStream(validRoom, stream, ''), []);
      assert.deepEqual(MediaCoordinator.targetedAddStream(validRoom, stream, null as any), []);

      // Exception safety: if room.addStream throws, targetedAddStream catches and returns []
      const throwingRoom = {
        addStream: () => {
          throw new Error('WebRTC internal transceiver allocation error');
        },
      };
      assert.doesNotThrow(() => {
        const result = MediaCoordinator.targetedAddStream(throwingRoom, stream, 'peer-err');
        assert.deepEqual(result, []);
      });
    });

    it('Empirical-1.4: Multi-peer room screen toggle simulation with recovery handshake', () => {
      // Simulate 1 broadcaster ('host') and 2 viewers ('viewer-1', 'viewer-2')
      let hostStream = new MockMediaStream('stream-v1');
      let hostStreamTrack = new MockMediaStreamTrack('video', 'track-v1');
      hostStream.addTrack(hostStreamTrack);

      const viewer1RemoteStreams = new Map<string, MockMediaStream>();
      const viewer2RemoteStreams = new Map<string, MockMediaStream>();

      // Initial stream received by viewers
      viewer1RemoteStreams.set('host', hostStream);
      viewer2RemoteStreams.set('host', hostStream);

      // STEP 1: Host toggles OFF screen share
      hostStreamTrack.stop(); // track ends
      const offStatus = MediaCoordinator.buildStreamStatusPayload(null, false, 'Host');
      assert.equal(offStatus.isStreaming, false);

      // Viewers process offStatus
      if (!offStatus.isStreaming) {
        viewer1RemoteStreams.delete('host');
        viewer2RemoteStreams.delete('host');
      }
      assert.equal(viewer1RemoteStreams.has('host'), false);
      assert.equal(viewer2RemoteStreams.has('host'), false);

      // STEP 2: Host restarts screen share with new stream
      const hostStreamV2 = new MockMediaStream('stream-v2');
      const hostTrackV2 = new MockMediaStreamTrack('video', 'track-v2');
      hostTrackV2.readyState = 'live';
      hostStreamV2.addTrack(hostTrackV2);

      const onStatus = MediaCoordinator.buildStreamStatusPayload(
        hostStreamV2 as unknown as MediaStream,
        true,
        'Host'
      );
      assert.equal(onStatus.isStreaming, true);
      assert.equal(onStatus.streamId, 'stream-v2');

      // STEP 3: Viewer 1 receives onStatus before stream packet arrives -> needs recovery
      const v1NeedsRecovery = MediaCoordinator.shouldRequestStreamRecovery(
        viewer1RemoteStreams.get('host') as unknown as MediaStream,
        onStatus
      );
      assert.equal(v1NeedsRecovery, true, 'Viewer 1 must detect missing stream and request recovery');

      // STEP 4: Host receives recovery request from Viewer 1 and performs targetedAddStream
      const targetedDispatches: { target: string; streamId: string }[] = [];
      const mockHostRoom = {
        addStream: (stream: any, opts: any) => {
          targetedDispatches.push({ target: opts.target, streamId: stream.id });
          return [Promise.resolve()];
        },
      };

      MediaCoordinator.targetedAddStream(mockHostRoom, hostStreamV2 as unknown as MediaStream, 'viewer-1');

      assert.equal(targetedDispatches.length, 1);
      assert.equal(targetedDispatches[0]?.target, 'viewer-1');
      assert.equal(targetedDispatches[0]?.streamId, 'stream-v2');
      // Viewer 2 was NOT targeted, zero leakage!
      assert.equal(targetedDispatches.some((d) => d.target === 'viewer-2'), false);

      // STEP 5: Viewer 1 receives stream-v2; now recovery check returns false
      viewer1RemoteStreams.set('host', hostStreamV2);
      const v1Recovered = MediaCoordinator.shouldRequestStreamRecovery(
        viewer1RemoteStreams.get('host') as unknown as MediaStream,
        onStatus
      );
      assert.equal(v1Recovered, false, 'Viewer 1 now has active stream with matching streamId');
    });
  });

  describe('Challenge 2: Peer Tracking Quarantine & Ghost Peer Elimination', () => {
    it('Empirical-2.1: Unverified PEX rumors must NEVER appear in getVerifiedPeers', () => {
      const tracker = new PeerTracker();

      // Ingest 20 unverified rumors from PEX gossip
      for (let i = 1; i <= 20; i++) {
        const isDirect = tracker.receivePeerExchange(`rumor-peer-${i}`, false, `Rumor ${i}`);
        assert.equal(isDirect, false);
      }

      // Invariant: unverifiedRumors has 20 items, directConnectedPeers has 0
      assert.equal(tracker.unverifiedRumors.size, 20);
      assert.equal(tracker.directConnectedPeers.size, 0);

      // Verified peers list MUST BE completely empty
      const verified = tracker.getVerifiedPeers();
      assert.equal(verified.length, 0);

      // Invariant: hasPeer and isVerified MUST be false for all rumors
      for (let i = 1; i <= 20; i++) {
        assert.equal(tracker.hasPeer(`rumor-peer-${i}`), false);
        assert.equal(tracker.isVerified(`rumor-peer-${i}`), false);
      }
    });

    it('Empirical-2.2: Quarantine promotion: rumors promoted ONLY upon direct WebRTC connection', () => {
      const tracker = new PeerTracker();

      tracker.receivePeerExchange('candidate-1', false, 'Candidate One');
      tracker.receivePeerExchange('candidate-2', false, 'Candidate Two');
      assert.equal(tracker.unverifiedRumors.size, 2);
      assert.equal(tracker.directConnectedPeers.size, 0);

      // Direct WebRTC connects ONLY for candidate-1
      const promoted = tracker.receivePeerExchange('candidate-1', true, 'Candidate One');
      assert.equal(promoted, true);

      assert.equal(tracker.unverifiedRumors.has('candidate-1'), false, 'candidate-1 must be removed from rumors');
      assert.equal(tracker.directConnectedPeers.has('candidate-1'), true, 'candidate-1 must be in directConnectedPeers');
      assert.equal(tracker.isVerified('candidate-1'), true);
      assert.equal(tracker.hasPeer('candidate-1'), true);

      // candidate-2 remains quarantined
      assert.equal(tracker.unverifiedRumors.has('candidate-2'), true);
      assert.equal(tracker.directConnectedPeers.has('candidate-2'), false);
      assert.equal(tracker.isVerified('candidate-2'), false);

      const verified = tracker.getVerifiedPeers();
      assert.equal(verified.length, 1);
      assert.equal(verified[0]?.id, 'candidate-1');
    });

    it('Empirical-2.3: peerDisconnected performs total purge of all state and watcher relations', () => {
      const tracker = new PeerTracker();

      tracker.addPeer('peer-alice', 'Alice', false, 1000);
      tracker.addPeer('peer-bob', 'Bob', false, 2000);
      tracker.setStreaming('peer-alice', true);
      tracker.setPing('peer-alice', 42);
      tracker.setPing('peer-bob', 88);

      // Bob watches Alice; Alice watches Bob
      tracker.addWatcher('peer-alice', 'peer-bob', 'Bob');
      tracker.addWatcher('peer-bob', 'peer-alice', 'Alice');

      assert.equal(tracker.getWatchers('peer-alice').length, 1);
      assert.equal(tracker.getWatchers('peer-bob').length, 1);
      assert.equal(tracker.isStreaming('peer-alice'), true);
      assert.equal(tracker.getPing('peer-alice'), 42);

      // Alice disconnects
      const removedName = tracker.peerDisconnected('peer-alice');
      assert.equal(removedName, 'Alice');

      // 1. Direct and verified maps
      assert.equal(tracker.hasPeer('peer-alice'), false);
      assert.equal(tracker.isVerified('peer-alice'), false);
      assert.equal(tracker.directConnectedPeers.has('peer-alice'), false);
      assert.equal(tracker.unverifiedRumors.has('peer-alice'), false);
      assert.equal(tracker.getUsername('peer-alice'), undefined);
      assert.equal(tracker.getPing('peer-alice'), undefined);
      assert.equal(tracker.isStreaming('peer-alice'), false);

      // 2. Watcher relationships completely purged
      // Alice is no longer watching Bob
      assert.equal(tracker.getWatchers('peer-bob').length, 0);
      // Alice's broadcast watchers list is deleted
      assert.equal(tracker.getWatchers('peer-alice').length, 0);

      // 3. Bob is completely unaffected
      assert.equal(tracker.hasPeer('peer-bob'), true);
      assert.equal(tracker.getPing('peer-bob'), 88);
    });

    it('Empirical-2.4: pruneStalePeers purges silent peers and preserves active ones', () => {
      const tracker = new PeerTracker();

      tracker.addPeer('peer-active-1', 'Active1');
      tracker.addPeer('peer-active-2', 'Active2');
      tracker.addPeer('peer-silent-1', 'Silent1');
      tracker.addPeer('peer-silent-2', 'Silent2');

      const now = Date.now();
      // Keep active peers fresh
      tracker.touchPeer('peer-active-1');
      tracker.touchPeer('peer-active-2');

      // Age silent peers past timeout (6000ms)
      (tracker as any).peerLastSeen.set('peer-silent-1', now - 6500);
      (tracker as any).peerLastSeen.set('peer-silent-2', now - 12000);

      const pruned = tracker.pruneStalePeers(6000);
      assert.equal(pruned.length, 2);
      assert.ok(pruned.includes('peer-silent-1'));
      assert.ok(pruned.includes('peer-silent-2'));

      // Invariant: silent peers must be completely purged
      assert.equal(tracker.hasPeer('peer-silent-1'), false);
      assert.equal(tracker.hasPeer('peer-silent-2'), false);
      assert.equal(tracker.directConnectedPeers.has('peer-silent-1'), false);
      assert.equal(tracker.directConnectedPeers.has('peer-silent-2'), false);

      // Invariant: active peers remain connected
      assert.equal(tracker.hasPeer('peer-active-1'), true);
      assert.equal(tracker.hasPeer('peer-active-2'), true);
      assert.equal(tracker.getVerifiedPeers().length, 2);
    });

    it('Empirical-2.5: High churn stress test: mixed PEX rumors, connects, disconnects', () => {
      const tracker = new PeerTracker();

      // Step 1: 50 unverified PEX rumors arrive
      for (let i = 0; i < 50; i++) {
        tracker.receivePeerExchange(`rumor-${i}`, false, `RumorUser ${i}`);
      }
      assert.equal(tracker.unverifiedRumors.size, 50);
      assert.equal(tracker.getVerifiedPeers().length, 0);

      // Step 2: 15 direct WebRTC peers connect (10 are new, 5 were previously rumors)
      for (let i = 0; i < 5; i++) {
        tracker.receivePeerExchange(`rumor-${i}`, true, `RumorUser ${i}`);
      }
      for (let i = 0; i < 10; i++) {
        tracker.receivePeerExchange(`direct-${i}`, true, `DirectUser ${i}`);
      }
      assert.equal(tracker.directConnectedPeers.size, 15);
      assert.equal(tracker.unverifiedRumors.size, 45); // 50 - 5 = 45
      assert.equal(tracker.getVerifiedPeers().length, 15);

      // Step 3: 7 peers disconnect explicitly
      for (let i = 0; i < 3; i++) {
        tracker.peerDisconnected(`rumor-${i}`);
      }
      for (let i = 0; i < 4; i++) {
        tracker.peerDisconnected(`direct-${i}`);
      }
      assert.equal(tracker.directConnectedPeers.size, 8); // 15 - 7 = 8
      assert.equal(tracker.getVerifiedPeers().length, 8);

      // Step 4: 3 direct peers become stale
      const now = Date.now();
      (tracker as any).peerLastSeen.set('direct-4', now - 8000);
      (tracker as any).peerLastSeen.set('direct-5', now - 9000);
      (tracker as any).peerLastSeen.set('direct-6', now - 10000);

      const pruned = tracker.pruneStalePeers(6000);
      assert.equal(pruned.length, 3);
      assert.equal(tracker.directConnectedPeers.size, 5); // 8 - 3 = 5
      assert.equal(tracker.getVerifiedPeers().length, 5);

      // Step 5: Verify all remaining verified peers are strictly valid
      const verified = tracker.getVerifiedPeers();
      for (const p of verified) {
        assert.ok(tracker.directConnectedPeers.has(p.id));
        assert.ok(!tracker.unverifiedRumors.has(p.id));
        assert.equal(tracker.isVerified(p.id), true);
      }
    });

    it('Empirical-2.6: Host election stability during churn and creator exit', () => {
      const tracker = new PeerTracker();
      const selfId = 'self-node';
      const myJoin = 5000;

      // Case 1: Creator present
      tracker.addPeer('peer-creator', 'OriginalHost', true, 1000);
      tracker.addPeer('peer-senior', 'SeniorPeer', false, 2000);
      assert.equal(tracker.isHost(selfId, myJoin, false), false);

      // Case 2: Creator disconnects -> SeniorPeer (joined at 2000) becomes host
      tracker.peerDisconnected('peer-creator');
      assert.equal(tracker.isHost(selfId, myJoin, false), false);

      // Case 3: SeniorPeer disconnects -> self-node (joined at 5000) becomes host!
      tracker.peerDisconnected('peer-senior');
      assert.equal(tracker.isHost(selfId, myJoin, false), true);

      // Case 4: A new junior peer joins (joined at 6000) -> self remains host
      tracker.addPeer('peer-junior', 'JuniorPeer', false, 6000);
      assert.equal(tracker.isHost(selfId, myJoin, false), true);

      // Case 5: Tie-break on join timestamp (both joined at 5000) -> lexicographical peerId
      // 'a-node' < 'self-node' -> 'a-node' wins
      tracker.addPeer('a-node', 'Alpha', false, 5000);
      assert.equal(tracker.isHost(selfId, myJoin, false), false);

      // 'z-node' > 'self-node' -> self wins
      tracker.removePeer('a-node');
      tracker.addPeer('z-node', 'Omega', false, 5000);
      assert.equal(tracker.isHost(selfId, myJoin, false), true);
    });
  });
});
