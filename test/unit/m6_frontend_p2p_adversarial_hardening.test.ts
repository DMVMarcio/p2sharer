import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockMediaStream, MockMediaStreamTrack } from '../e2e/harness/dom-mock.ts';
import { stateStore } from '../../src/core/state_store.ts';
import { SignalingManager } from '../../src/p2p/signaling_manager.ts';
import { MediaCoordinator } from '../../src/p2p/media_coordinator.ts';
import { PeerTracker } from '../../src/p2p/peer_tracker.ts';
import { NativeVideoBridge } from '../../src/video/native_video_bridge.ts';
import type {
  SignalingFailoverEvent,
  SignalingTransport,
  StreamStatusPayload,
} from '../../src/core/types.ts';

function makeStream(id: string, options: { hasVideo?: boolean; hasAudio?: boolean } = {}): MockMediaStream {
  const { hasVideo = true, hasAudio = true } = options;
  const stream = new MockMediaStream(id);
  if (hasVideo) {
    stream.addTrack(new MockMediaStreamTrack('video', `${id}-video`));
  }
  if (hasAudio) {
    stream.addTrack(new MockMediaStreamTrack('audio', `${id}-audio`));
  }
  return stream;
}

describe('Tier 5 Adversarial Coverage Hardening: Frontend, Video & P2P Architecture', () => {

  // =========================================================================
  // Challenge Area 2: Rapid Multi-Transport Failover Under Intermittent Network Connectivity
  // =========================================================================
  describe('Challenge Area 2: Rapid Multi-Transport Signaling Failover & Concurrency Guards', () => {
    it('2.1: High-Frequency Cyclical Failover Stress (60 Transitions)', () => {
      const manager = new SignalingManager();
      const transitions: SignalingFailoverEvent[] = [];
      manager.onFailover((ev) => transitions.push(ev));

      const expectedCycle: SignalingTransport[] = ['mqtt', 'nostr', 'torrent'];
      const TOTAL_TRANSITIONS = 60;

      for (let i = 0; i < TOTAL_TRANSITIONS; i++) {
        const expectedCurrent = expectedCycle[i % 3]!;
        const expectedNext = expectedCycle[(i + 1) % 3]!;

        assert.strictEqual(manager.getActiveTransport(), expectedCurrent);
        const next = manager.recordWatchdogFailure(`intermittent_drop_${i}`);
        assert.strictEqual(next, expectedNext);
        assert.strictEqual(manager.getActiveTransport(), expectedNext);
      }

      assert.strictEqual(transitions.length, TOTAL_TRANSITIONS);
      assert.strictEqual(manager.failoverHistory.length, TOTAL_TRANSITIONS);
    });

    it('2.2: Concurrent Failover Guard & Reentrancy Lock', async () => {
      const manager = new SignalingManager();
      let reconnectHandlerCallCount = 0;
      let resolveReconnect: (() => void) | null = null;

      // Register an asynchronous reconnection handler that pauses
      manager.setRoomReconnectionHandler(() => {
        reconnectHandlerCallCount++;
        return new Promise<void>((resolve) => {
          resolveReconnect = resolve;
        });
      });

      // Simulate active room
      (manager as any).activeRoom = { leave: async () => {} };
      (manager as any).lastRoomParams = { config: {}, topic: 'stress-topic' };

      // Trigger first failover (starts executeRoomFailover)
      manager.recordWatchdogFailure('stall_1');
      assert.strictEqual(
        (manager as any).isFailingOver,
        true,
        'isFailingOver lock must be true while asynchronous reconnect handler is executing'
      );
      assert.strictEqual(reconnectHandlerCallCount, 1);

      // Trigger second failover while first is in-flight
      manager.recordWatchdogFailure('stall_2');
      // Because isFailingOver is true, executeRoomFailover must NOT spawn another reconnect handler
      assert.strictEqual(
        reconnectHandlerCallCount,
        1,
        'Concurrent watchdog trigger must NOT spawn overlapping reconnection handlers'
      );

      // Complete first reconnect
      resolveReconnect!();
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.strictEqual(
        (manager as any).isFailingOver,
        false,
        'isFailingOver lock must be cleanly released in finally block'
      );
    });

    it('2.3: Network Flapping (online/offline Event Flooding)', () => {
      const listeners: Record<string, Function[]> = {};
      const mockWindow = {
        addEventListener: (event: string, fn: Function) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(fn);
        },
        removeEventListener: (event: string, fn: Function) => {
          if (listeners[event]) {
            const idx = listeners[event].indexOf(fn);
            if (idx !== -1) listeners[event].splice(idx, 1);
          }
        },
        dispatchEvent: (event: { type: string }) => {
          listeners[event.type]?.forEach((fn) => fn(event));
          return true;
        },
      };

      const originalWindow = (globalThis as any).window;
      (globalThis as any).window = mockWindow;

      try {
        const manager = new SignalingManager();
        (manager as any).consecutiveStalls = 1;

        // Flood 30 rapid online/offline network events
        for (let i = 0; i < 30; i++) {
          mockWindow.dispatchEvent({ type: 'offline' });
          mockWindow.dispatchEvent({ type: 'online' });
        }

        // consecutiveStalls must be reset to 0 by online listener
        assert.strictEqual((manager as any).consecutiveStalls, 0);
      } finally {
        (globalThis as any).window = originalWindow;
      }
    });

    it('2.4: Watchdog Initial Grace Period Defense', () => {
      const manager = new SignalingManager();
      (manager as any).activeRoom = { leave: async () => {} };
      (manager as any).lastRoomParams = { config: {}, topic: 'room-grace' };
      (manager as any).roomJoinedTimestamp = Date.now(); // 0ms elapsed (<4000ms grace)
      manager.getRelaySockets = () => ({}); // 0 relays connected

      // Multiple health checks within grace period
      for (let i = 0; i < 10; i++) {
        manager.checkRelayHealth();
      }

      assert.strictEqual(
        (manager as any).consecutiveStalls,
        0,
        'Watchdog must not increment stall count during 4-second initial join grace period'
      );
      assert.strictEqual(manager.getActiveTransport(), 'mqtt');
    });

    it('2.5: Resilient Reconnection Handler Failure Recovery', async () => {
      const manager = new SignalingManager();
      manager.setRoomReconnectionHandler(() => {
        throw new Error('Socket network completely dead');
      });

      (manager as any).activeRoom = { leave: async () => {} };
      (manager as any).lastRoomParams = { config: {}, topic: 'room-fail' };

      // Trigger failover; reconnection handler throws
      assert.doesNotThrow(() => {
        manager.recordWatchdogFailure('fatal_drop');
      });

      // Allow microtask ticks
      await new Promise((resolve) => setTimeout(resolve, 5));

      assert.strictEqual(
        (manager as any).isFailingOver,
        false,
        'isFailingOver must reset to false even when reconnectHandler throws'
      );
    });
  });

  // =========================================================================
  // Challenge Area 3: Screen Share Renegotiation & Track Replacement Under Degraded ICE
  // =========================================================================
  describe('Challenge Area 3: Screen Share Renegotiation & Degraded ICE States', () => {
    it('3.1: Stream Recovery Decision Matrix (shouldRequestStreamRecovery)', () => {
      // 1. Broadcaster stopped -> no recovery
      const stoppedPayload: StreamStatusPayload = { isStreaming: false, timestamp: Date.now() };
      assert.strictEqual(MediaCoordinator.shouldRequestStreamRecovery(null, stoppedPayload), false);

      // 2. Broadcaster active, viewer currentStream is null -> recovery needed
      const activePayload: StreamStatusPayload = {
        isStreaming: true,
        streamId: 'broadcaster-stream-1',
        timestamp: Date.now(),
      };
      assert.strictEqual(MediaCoordinator.shouldRequestStreamRecovery(null, activePayload), true);

      // 3. Broadcaster active, viewer currentStream has 0 video tracks -> recovery needed
      const audioOnlyStream = makeStream('audio-only', { hasVideo: false, hasAudio: true });
      assert.strictEqual(MediaCoordinator.shouldRequestStreamRecovery(audioOnlyStream as any, activePayload), true);

      // 4. Broadcaster active, viewer currentStream video track ended -> recovery needed
      const endedStream = makeStream('ended-stream', { hasVideo: true, hasAudio: false });
      endedStream.getVideoTracks()[0].readyState = 'ended';
      assert.strictEqual(MediaCoordinator.shouldRequestStreamRecovery(endedStream as any, activePayload), true);

      // 5. Broadcaster active, viewer stream is live and matching streamId -> NO recovery (already active)
      const liveStream = makeStream('broadcaster-stream-1', { hasVideo: true, hasAudio: true });
      assert.strictEqual(MediaCoordinator.shouldRequestStreamRecovery(liveStream as any, activePayload), false);

      // 6. Broadcaster toggled screen share (new streamId) -> recovery triggered!
      const renegotiatedPayload: StreamStatusPayload = {
        isStreaming: true,
        streamId: 'broadcaster-stream-2-new',
        timestamp: Date.now(),
      };
      assert.strictEqual(MediaCoordinator.shouldRequestStreamRecovery(liveStream as any, renegotiatedPayload), true);
    });

    it('3.2: Codec Preferences & Sender Bitrate Resilience on Degraded RTCPeerConnections', async () => {
      // 1. Completely null / undefined peer connection
      assert.doesNotThrow(() => {
        MediaCoordinator.configureCodecPreferences(null as any);
      });

      // 2. Mock PC where getTransceivers throws an error
      const brokenPc = {
        getTransceivers: () => {
          throw new Error('ICE connection closed / invalid state');
        },
      };

      assert.doesNotThrow(() => {
        MediaCoordinator.configureCodecPreferences(brokenPc as any);
      });

      // 3. Mock PC with senders where setParameters rejects
      const rejectingSenderPc = {
        getSenders: () => [
          {
            track: { kind: 'video' },
            getParameters: () => ({ encodings: [{}] }),
            setParameters: async () => {
              throw new Error('RTCRtpSender closed');
            },
          },
        ],
      };

      await assert.doesNotReject(async () => {
        await MediaCoordinator.applySenderBitrate(rejectingSenderPc as any, 25000000, 60);
      });

      // 4. Architectural hardening verification:
      // If getSenders() itself throws (e.g. peer connection closed), verify defensive handling
      const throwingGetSendersPc = {
        getSenders: () => {
          throw new Error('Peer connection destroyed');
        },
      };

      // Demonstrates that applySenderBitrate safely catches exceptions around pc.getSenders()
      await assert.doesNotReject(
        async () => {
          await MediaCoordinator.applySenderBitrate(throwingGetSendersPc as any, 25000000, 60);
        },
        'applySenderBitrate safely handles throwing getSenders() without unhandled rejections'
      );

      // 5. Verification of maintain-resolution degradationPreference and scaleResolutionDownBy = 1.0
      let capturedParams: any = null;
      const validSenderPc = {
        getSenders: () => [
          {
            track: { kind: 'video' },
            getParameters: () => ({ encodings: [{}] }),
            setParameters: async (params: any) => {
              capturedParams = params;
            },
          },
        ],
      };

      await MediaCoordinator.applySenderBitrate(validSenderPc as any, 15000000, 60);
      assert.ok(capturedParams, 'sender.setParameters was invoked with parameters');
      assert.strictEqual(capturedParams.degradationPreference, 'maintain-resolution');
      assert.strictEqual(capturedParams.encodings[0].scaleResolutionDownBy, 1.0);
      assert.strictEqual(capturedParams.encodings[0].maxBitrate, 15000000);
      assert.strictEqual(capturedParams.encodings[0].maxFramerate, 60);
    });

    it('3.3: Targeted Stream Dispatch Exception Isolation', () => {
      // Mock room whose addStream throws
      const brokenRoom = {
        addStream: () => {
          throw new Error('WebRTC room signaling pipe broken');
        },
      };

      const stream = makeStream('dummy-stream');

      // Targeted add stream must safely return empty array instead of crashing
      const promises = MediaCoordinator.targetedAddStream(brokenRoom, stream as any, 'peer-target');
      assert.deepStrictEqual(promises, []);

      // Broadcast stream must also catch and return empty array
      const broadcastPromises = MediaCoordinator.broadcastStream(brokenRoom, stream as any);
      assert.deepStrictEqual(broadcastPromises, []);
    });
  });

  // =========================================================================
  // Challenge Area 5: Large Room Scaling (15+ Participants) Slot Reconciliation
  // =========================================================================
  describe('Challenge Area 5: Large Room Scaling (15+ Participants) & State Reconciliation', () => {

    it('5.3: PeerTracker PEX Rumor Quarantine Under 100 Gossip Rumors', () => {
      const tracker = new PeerTracker();

      // Inject 100 unverified rumors
      for (let i = 1; i <= 100; i++) {
        const isDirect = false;
        const accepted = tracker.receivePeerExchange(`rumor-peer-${i}`, isDirect, `Rumor ${i}`);
        assert.strictEqual(accepted, false, 'Unverified PEX rumor must return false (quarantined)');
      }

      assert.strictEqual(tracker.unverifiedRumors.size, 100);
      assert.strictEqual(tracker.directConnectedPeers.size, 0);
      assert.strictEqual(tracker.getVerifiedPeers().length, 0, 'Zero ghost cards permitted in verified peers list');

      // Now promote 10 peers to direct WebRTC connections
      for (let i = 1; i <= 10; i++) {
        const isDirect = true;
        const accepted = tracker.receivePeerExchange(`rumor-peer-${i}`, isDirect, `Verified ${i}`);
        assert.strictEqual(accepted, true);
      }

      assert.strictEqual(tracker.directConnectedPeers.size, 10);
      assert.strictEqual(tracker.unverifiedRumors.size, 90);
      assert.strictEqual(tracker.getVerifiedPeers().length, 10);
    });

    it('5.4: Deterministic Host Election Under Large Room Churn', () => {
      const tracker = new PeerTracker();
      const mySelfId = 'self-node';
      const myJoinTime = 500;

      // Case A: Local user is room creator -> immediately host
      assert.strictEqual(tracker.isHost(mySelfId, myJoinTime, true), true);

      // Case B: Local user is not creator, no peers -> local user is host
      assert.strictEqual(tracker.isHost(mySelfId, myJoinTime, false), true);

      // Case C: Add older peer (joined at 200) -> older peer is host
      tracker.addPeer('older-peer', 'Alice', false, 200);
      assert.strictEqual(tracker.isHost(mySelfId, myJoinTime, false), false);

      // Case D: Older peer leaves -> local user (500) becomes host again
      tracker.removePeer('older-peer');
      assert.strictEqual(tracker.isHost(mySelfId, myJoinTime, false), true);

      // Case E: Another peer joins with isCreator: true (even if joined later at 900)
      tracker.addPeer('creator-peer', 'Bob Creator', true, 900);
      assert.strictEqual(tracker.isHost(mySelfId, myJoinTime, false), false);

      // Case F: Creator peer leaves -> local user becomes host again
      tracker.removePeer('creator-peer');
      assert.strictEqual(tracker.isHost(mySelfId, myJoinTime, false), true);

      // Case G: Tie-break on identical timestamps:
      // mySelfId = 'self-node', opponentId = 'aaa-peer' (lexicographically lower)
      tracker.addPeer('aaa-peer', 'AAA', false, 500);
      assert.strictEqual(tracker.isHost(mySelfId, myJoinTime, false), false);

      // opponentId = 'zzz-peer' (lexicographically higher)
      tracker.removePeer('aaa-peer');
      tracker.addPeer('zzz-peer', 'ZZZ', false, 500);
      assert.strictEqual(tracker.isHost(mySelfId, myJoinTime, false), true);
    });
  });

  // =========================================================================
  // Challenge Area 6: StateStore & Audio Filter Configuration Robustness
  // =========================================================================
  describe('Challenge Area 6: StateStore Robustness & Boundary Handling', () => {
    it('6.1: parseResolution Handles All Standard and Corrupted Strings', () => {
      assert.deepStrictEqual(stateStore.parseResolution('4k'), { width: 3840, height: 2160, label: '4K' });
      assert.deepStrictEqual(stateStore.parseResolution('1440p'), { width: 2560, height: 1440, label: '1440p' });
      assert.deepStrictEqual(stateStore.parseResolution('1080p'), { width: 1920, height: 1080, label: '1080p' });
      assert.deepStrictEqual(stateStore.parseResolution('720p'), { width: 1280, height: 720, label: '720p' });
      assert.deepStrictEqual(stateStore.parseResolution('480p'), { width: 854, height: 480, label: '480p' });
      assert.deepStrictEqual(stateStore.parseResolution('360p'), { width: 640, height: 360, label: '360p' });

      // Corrupted / boundary inputs default to 1080p
      assert.deepStrictEqual(stateStore.parseResolution('invalid_res'), { width: 1920, height: 1080, label: '1080p' });
      assert.deepStrictEqual(stateStore.parseResolution(''), { width: 1920, height: 1080, label: '1080p' });
      assert.deepStrictEqual(stateStore.parseResolution('8k'), { width: 1920, height: 1080, label: '1080p' });
    });

    it('6.2: Corrupted LocalStorage JSON Graceful Recovery', () => {
      // Mock localStorage with corrupted JSON strings
      const mockStorage: Record<string, string> = {
        p2sharer_audio_exclude_names: '{invalid json syntax',
        p2sharer_audio_include_names: '[1, 2, not a string or valid json',
        p2sharer_default_fps: 'not-a-number',
      };

      const originalLocalStorage = (globalThis as any).localStorage;
      (globalThis as any).localStorage = {
        getItem: (k: string) => mockStorage[k] || null,
        setItem: (k: string, v: string) => {
          mockStorage[k] = v;
        },
      };

      try {
        assert.doesNotThrow(() => {
          stateStore.loadFromStorage();
        });

        // Corrupted exclude names should fall back to default
        assert.ok(stateStore.excludeProcessNames.has('p2sharer'));
        assert.ok(stateStore.excludeProcessNames.has('p2sharer.exe'));
        // Corrupted include names should be empty
        assert.strictEqual(stateStore.includeProcessNames.size, 0);
      } finally {
        (globalThis as any).localStorage = originalLocalStorage;
      }
    });

    it('6.3: TURN Configuration Sanitization and Scheme Normalization', () => {
      const mockStorage: Record<string, string> = {
        p2sharer_turn_enabled: 'true',
        p2sharer_turn_url: 'relay.example.com:3478',
        p2sharer_turn_user: 'p2puser',
        p2sharer_turn_cred: 'p2ppass',
        p2sharer_turn_force_relay: 'true',
      };

      const originalLocalStorage = (globalThis as any).localStorage;
      (globalThis as any).localStorage = {
        getItem: (k: string) => mockStorage[k] || null,
        setItem: (k: string, v: string) => {
          mockStorage[k] = v;
        },
      };

      try {
        const config = stateStore.getTurnConfig();
        assert.strictEqual(config.enabled, true);
        assert.strictEqual(config.url, 'turn:relay.example.com:3478');
        assert.strictEqual(config.forceRelay, true);
        assert.strictEqual(config.username, 'p2puser');
        assert.strictEqual(config.credential, 'p2ppass');
      } finally {
        (globalThis as any).localStorage = originalLocalStorage;
      }
    });
  });

  // =========================================================================
  // Challenge Area 7: Native Video Bridge Capture Pipeline Robustness
  // =========================================================================
  describe('Challenge Area 7: Native Video Bridge Lifecycle & Signal Resilience', () => {
    it('7.1: High-Frequency Stop Lifecycle Idempotency', async () => {
      const bridge = new NativeVideoBridge();

      // Initial state
      assert.strictEqual(bridge.isCapturingDirectGpu(), false);
      assert.strictEqual(bridge.isCapturingNative(), false);
      assert.strictEqual(bridge.getActiveStream(), null);

      // Stop called when idle must be completely safe
      await assert.doesNotReject(async () => {
        await bridge.stop();
        await bridge.stopCapture();
      });

      assert.strictEqual(bridge.isCapturingDirectGpu(), false);
      assert.strictEqual(bridge.isCapturingNative(), false);
      assert.strictEqual(bridge.getActiveStream(), null);
    });

    it('7.2: Direct GPU Display Media Capture Setup & Constraints', async () => {
      const bridge = new NativeVideoBridge();
      const mockStream = makeStream('display-stream-1');

      const originalMediaDevices = (globalThis as any).navigator?.mediaDevices;
      if (!(globalThis as any).navigator) {
        (globalThis as any).navigator = {};
      }
      (globalThis as any).navigator.mediaDevices = {
        getDisplayMedia: async () => mockStream,
      };

      try {
        const stream = await bridge.startDisplayMediaCapture(60);
        assert.strictEqual(stream, mockStream);
        assert.strictEqual(bridge.isCapturingDirectGpu(), true);
        assert.strictEqual(bridge.isCapturingNative(), false);
        assert.strictEqual(bridge.getActiveStream(), mockStream);

        // Detail contentHint applied for screen sharing text fidelity
        const track = stream.getVideoTracks()[0];
        assert.strictEqual((track as any).contentHint, 'detail');

        // Cleanup
        await bridge.stop();
        assert.strictEqual(bridge.isCapturingDirectGpu(), false);
        assert.strictEqual(bridge.getActiveStream(), null);
      } finally {
        if (originalMediaDevices) {
          (globalThis as any).navigator.mediaDevices = originalMediaDevices;
        } else {
          delete (globalThis as any).navigator.mediaDevices;
        }
      }
    });
  });
});
