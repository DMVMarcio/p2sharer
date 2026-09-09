import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupTestDOM,
  MockElement,
  MockVideoElement,
  MockMediaStream,
  MockMediaStreamTrack,
  MockAudioContext,
} from '../e2e/harness/dom-mock.ts';
import { ViewerRenderer } from '../../src/video/viewer_renderer.ts';
import { audioContextManager } from '../../src/audio/audio_context_manager.ts';
import { stateStore } from '../../src/core/state_store.ts';
import { SignalingManager } from '../../src/p2p/signaling_manager.ts';
import { MediaCoordinator } from '../../src/p2p/media_coordinator.ts';
import { PeerTracker } from '../../src/p2p/peer_tracker.ts';
import { NativeVideoBridge } from '../../src/video/native_video_bridge.ts';
import type {
  RoomSlotInfo,
  SignalingFailoverEvent,
  SignalingTransport,
  StreamStatusPayload,
} from '../../src/core/types.ts';

function createRoomTestEnvironment() {
  const dom = setupTestDOM();

  const gridWrapper = dom.document.createElement('div');
  dom.document.registerElement('streams-grid-wrapper', gridWrapper);

  const spotlightStage = dom.document.createElement('div');
  dom.document.registerElement('spotlight-stage', spotlightStage);

  const featuredArea = dom.document.createElement('div');
  dom.document.registerElement('spotlight-featured-area', featuredArea);

  const trayStrip = dom.document.createElement('div');
  dom.document.registerElement('spotlight-tray-strip', trayStrip);

  const sharingTag = dom.document.createElement('span');
  dom.document.registerElement('room-sharing-status-tag', sharingTag);

  const liveBadge = dom.document.createElement('span');
  dom.document.registerElement('room-live-badge', liveBadge);

  // Reset stateStore to deterministic defaults
  stateStore.roomSlots = [];
  stateStore.pinnedPeerId = null;
  stateStore.layoutMode = 'grid';
  stateStore.subscribedStreams.clear();
  audioContextManager.cleanup();

  const requestedPeers: string[] = [];
  const stoppedPeers: string[] = [];

  const callbacks = {
    onRequestStream: (peerId: string) => {
      requestedPeers.push(peerId);
    },
    onStopWatchingStream: (peerId: string) => {
      stoppedPeers.push(peerId);
    },
    getPeerPing: (_peerId: string) => 25,
  };

  const renderer = new ViewerRenderer(callbacks);

  return {
    dom,
    gridWrapper,
    spotlightStage,
    featuredArea,
    trayStrip,
    sharingTag,
    liveBadge,
    callbacks,
    renderer,
    requestedPeers,
    stoppedPeers,
    cleanup: () => {
      renderer.clear();
      dom.cleanup();
      audioContextManager.cleanup();
      stateStore.roomSlots = [];
      stateStore.pinnedPeerId = null;
      stateStore.layoutMode = 'grid';
      stateStore.subscribedStreams.clear();
    },
  };
}

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
  // Challenge Area 1: Defense-in-Depth HTML Injection & Sanitization in Card Rendering
  // =========================================================================
  describe('Challenge Area 1: HTML Injection & Sanitization in ViewerRenderer', () => {
    it('1.1: Defense-in-Depth HTML Entity Sanitization in Initial createCardElement()', () => {
      const env = createRoomTestEnvironment();
      try {
        // Construct adversarial username containing HTML elements
        const maliciousPayload = '<b id="injected-bold">Evil</b><img id="injected-img" src="x">';

        // Case A: Remote non-streaming participant card
        const slotAvatar: RoomSlotInfo = {
          peerId: 'adversary-1',
          senderName: maliciousPayload,
          color: 'hsl(10, 65%, 45%)',
          isStreaming: false,
          isLocal: false,
        };

        stateStore.roomSlots = [slotAvatar];
        env.renderer.renderRoomCards();

        const cardAvatar = env.gridWrapper.children[0] as MockElement;
        assert.ok(cardAvatar, 'Avatar card must exist in DOM');

        // Verify that HTML entity escaping prevents parsing tags into child DOM elements
        const injectedBold = cardAvatar.querySelector('#injected-bold');
        const injectedImg = cardAvatar.querySelector('#injected-img');
        assert.strictEqual(
          injectedBold,
          null,
          'Sanitization verification: <b id="injected-bold"> must not be parsed into a DOM element'
        );
        assert.strictEqual(
          injectedImg,
          null,
          'Sanitization verification: <img id="injected-img"> must not be parsed into a DOM element'
        );

        // Case B: Remote streaming subscribed participant card
        const stream = makeStream('stream-adv-2');
        const slotStream: RoomSlotInfo = {
          peerId: 'adversary-2',
          senderName: maliciousPayload,
          color: 'hsl(120, 65%, 45%)',
          isStreaming: true,
          isLocal: false,
          stream: stream as any,
        };

        stateStore.roomSlots = [slotStream];
        stateStore.subscribedStreams.add('adversary-2');
        env.renderer.renderRoomCards();

        const cardStream = env.gridWrapper.children[0] as MockElement;
        assert.ok(cardStream, 'Stream card must exist in DOM');
        const streamInjectedBold = cardStream.querySelector('#injected-bold');
        assert.strictEqual(
          streamInjectedBold,
          null,
          'Sanitization verification: Stream overlay in createCardElement() must not parse HTML tags into DOM nodes'
        );
      } finally {
        env.cleanup();
      }
    });

    it('1.2: Defense Contrast — In-Place Metadata Updates Safely Use textContent', () => {
      const env = createRoomTestEnvironment();
      try {
        const initialSlot: RoomSlotInfo = {
          peerId: 'peer-safe',
          senderName: 'BenignName',
          color: 'hsl(200, 65%, 45%)',
          isStreaming: false,
          isLocal: false,
        };

        stateStore.roomSlots = [initialSlot];
        env.renderer.renderRoomCards();

        const card = env.gridWrapper.children[0] as MockElement;
        assert.ok(card, 'Initial benign card created');

        // Now mutate the name to an adversarial payload and trigger in-place reconciliation
        const maliciousPayload = '<span id="injected-span">Attack</span>';
        initialSlot.senderName = maliciousPayload;
        env.renderer.renderRoomCards();

        // In updateCardContentInPlace, label.textContent = slot.senderName is used
        const label = card.querySelector('.participant-avatar-label');
        assert.ok(label, 'Avatar label must exist');
        assert.strictEqual(
          label.textContent,
          maliciousPayload,
          'textContent safely assigns raw markup string literal without executing or creating new element tree'
        );
      } finally {
        env.cleanup();
      }
    });

    it('1.3: Boundary Formatting, RTL Overrides, and Massive Usernames', () => {
      const env = createRoomTestEnvironment();
      try {
        const extremeNames = [
          'A'.repeat(5000), // Massive 5k payload
          '\u202E\u202D\u200F\u200B\uFEFFAdmin', // Bidirectional RTL overrides and zero-width spaces
          '<script>alert("xss")</script>', // Script tag
          'Normal & <Special> "Quotes" \'Single\' /Slash\\', // Entity boundary characters
          '', // Empty string
        ];

        extremeNames.forEach((name, idx) => {
          const slot: RoomSlotInfo = {
            peerId: `extreme-peer-${idx}`,
            senderName: name,
            color: 'hsl(50, 65%, 45%)',
            isStreaming: false,
            isLocal: false,
          };
          stateStore.roomSlots = [slot];
          assert.doesNotThrow(() => {
            env.renderer.renderRoomCards();
          }, `renderRoomCards must not throw on extreme username index ${idx}`);

          const card = env.gridWrapper.children[0] as MockElement;
          assert.ok(card, `Card must be created for extreme name index ${idx}`);
        });
      } finally {
        env.cleanup();
      }
    });
  });

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
  // Challenge Area 4: Concurrent Spotlight Reparenting & Peer Pinning / Layout Switches
  // =========================================================================
  describe('Challenge Area 4: Concurrent Spotlight Reparenting & Peer Pinning', () => {
    it('4.1: 50x Rapid Layout Mode Switching (Grid <-> Spotlight) with 6 Active Streams', () => {
      const env = createRoomTestEnvironment();
      try {
        const streamRefs: MockMediaStream[] = [];
        const slots: RoomSlotInfo[] = [];

        for (let i = 1; i <= 6; i++) {
          const s = makeStream(`stream-peer-${i}`);
          streamRefs.push(s);
          slots.push({
            peerId: `peer-${i}`,
            senderName: `Streamer ${i}`,
            color: 'hsl(180, 65%, 45%)',
            isStreaming: true,
            isLocal: false,
            stream: s as any,
          });
          stateStore.subscribedStreams.add(`peer-${i}`);
        }

        stateStore.roomSlots = slots;
        env.renderer.renderRoomCards();

        // Initial check: all 6 cards in gridWrapper
        assert.strictEqual(env.gridWrapper.children.length, 6);
        const originalVideoElements = env.gridWrapper.children.map(
          (c) => (c as MockElement).querySelector('video') as MockVideoElement
        );
        originalVideoElements.forEach((v) => assert.ok(v, 'Video element must exist'));

        // Rapid 50x layout flapping
        for (let cycle = 0; cycle < 50; cycle++) {
          const mode = cycle % 2 === 0 ? 'spotlight' : 'grid';
          stateStore.layoutMode = mode;
          stateStore.pinnedPeerId = mode === 'spotlight' ? 'peer-1' : null;

          env.renderer.renderRoomCards();

          if (mode === 'grid') {
            assert.strictEqual(env.gridWrapper.children.length, 6);
            assert.strictEqual(env.featuredArea.children.length, 0);
            assert.strictEqual(env.trayStrip.children.length, 0);
          } else {
            assert.strictEqual(env.gridWrapper.children.length, 0);
            assert.strictEqual(env.featuredArea.children.length, 1);
            assert.strictEqual(env.trayStrip.children.length, 5);
          }
        }

        // Switch back to grid for final evaluation
        stateStore.layoutMode = 'grid';
        stateStore.pinnedPeerId = null;
        env.renderer.renderRoomCards();

        assert.strictEqual(env.gridWrapper.children.length, 6);
        // Verify referential identity of video elements: strictly identical instances preserved
        const finalVideoElements = env.gridWrapper.children.map(
          (c) => (c as MockElement).querySelector('video') as MockVideoElement
        );

        for (let i = 0; i < 6; i++) {
          assert.strictEqual(
            finalVideoElements[i],
            originalVideoElements[i],
            `Video element for peer ${i + 1} must preserve referential identity across 50 layout switches`
          );
          assert.strictEqual(
            finalVideoElements[i]?.srcObject,
            streamRefs[i],
            `Video srcObject for peer ${i + 1} must remain attached to original MediaStream`
          );
        }
      } finally {
        env.cleanup();
      }
    });

    it('4.2: Dynamic Pin Switching Among Multiple Remote Peers in Spotlight', () => {
      const env = createRoomTestEnvironment();
      try {
        const slots: RoomSlotInfo[] = [];
        for (let i = 1; i <= 5; i++) {
          const s = makeStream(`stream-${i}`);
          slots.push({
            peerId: `peer-${i}`,
            senderName: `User ${i}`,
            color: 'hsl(150, 65%, 45%)',
            isStreaming: true,
            isLocal: false,
            stream: s as any,
          });
          stateStore.subscribedStreams.add(`peer-${i}`);
        }

        stateStore.roomSlots = slots;
        stateStore.layoutMode = 'spotlight';

        // Cycle pin across peer-1, peer-3, peer-5, peer-2
        const pinSequence = ['peer-1', 'peer-3', 'peer-5', 'peer-2'];

        pinSequence.forEach((targetPeerId) => {
          stateStore.pinnedPeerId = targetPeerId;
          env.renderer.renderRoomCards();

          // Exactly 1 card in featured area
          assert.strictEqual(env.featuredArea.children.length, 1);
          const featuredCard = env.featuredArea.children[0] as MockElement;
          assert.strictEqual(featuredCard.attributes.get('data-peer-id'), targetPeerId);
          assert.ok(featuredCard.classList.contains('featured'));

          // Remaining 4 cards in tray strip
          assert.strictEqual(env.trayStrip.children.length, 4);
          const trayPeerIds = env.trayStrip.children.map((c) => (c as MockElement).attributes.get('data-peer-id'));
          assert.ok(!trayPeerIds.includes(targetPeerId), 'Featured peer must not appear in tray strip');

          // Inactive container is clean
          assert.strictEqual(env.gridWrapper.children.length, 0);
        });
      } finally {
        env.cleanup();
      }
    });

    it('4.3: Auto-Reversion to Grid on Pinned Peer Departure', () => {
      const env = createRoomTestEnvironment();
      try {
        const stream1 = makeStream('stream-departing');
        const stream2 = makeStream('stream-remaining');

        const slots: RoomSlotInfo[] = [
          {
            peerId: 'peer-departing',
            senderName: 'Departing Host',
            color: 'hsl(0, 65%, 45%)',
            isStreaming: true,
            isLocal: false,
            stream: stream1 as any,
          },
          {
            peerId: 'peer-remaining',
            senderName: 'Remaining Viewer',
            color: 'hsl(200, 65%, 45%)',
            isStreaming: true,
            isLocal: false,
            stream: stream2 as any,
          },
        ];

        stateStore.roomSlots = slots;
        stateStore.subscribedStreams.add('peer-departing');
        stateStore.subscribedStreams.add('peer-remaining');
        stateStore.layoutMode = 'spotlight';
        stateStore.pinnedPeerId = 'peer-departing';

        env.renderer.renderRoomCards();

        assert.strictEqual(stateStore.layoutMode, 'spotlight');
        assert.strictEqual(env.featuredArea.children.length, 1);

        // Departing peer leaves roomSlots
        stateStore.roomSlots = [slots[1]!];
        env.renderer.renderRoomCards();

        // Auto-revert assertions:
        assert.strictEqual(
          stateStore.pinnedPeerId,
          null,
          'pinnedPeerId must be nullified when pinned peer is missing from roomSlots'
        );
        assert.strictEqual(
          stateStore.layoutMode,
          'grid',
          'layoutMode must automatically revert to grid when pinned peer departs'
        );
        assert.strictEqual(env.gridWrapper.children.length, 1);
        assert.strictEqual(env.featuredArea.children.length, 0);
        assert.strictEqual(env.trayStrip.children.length, 0);
      } finally {
        env.cleanup();
      }
    });
  });

  // =========================================================================
  // Challenge Area 5: Large Room Scaling (15+ Participants) Slot Reconciliation
  // =========================================================================
  describe('Challenge Area 5: Large Room Scaling (15+ Participants) & State Reconciliation', () => {
    it('5.1: 25-Participant Room Scaling & Keyed Element Invariance Across 20 Re-Renders', () => {
      const env = createRoomTestEnvironment();
      try {
        const slots: RoomSlotInfo[] = [];

        // 1 Local non-streaming participant
        slots.push({
          peerId: 'local',
          senderName: 'Host Self',
          color: 'hsl(240, 65%, 45%)',
          isStreaming: false,
          isLocal: true,
        });

        // 24 Remote participants: 8 streaming with media, 16 avatar-only
        const streamingMediaMap = new Map<string, MockMediaStream>();

        for (let i = 1; i <= 24; i++) {
          const pid = `peer-${i}`;
          const isStreaming = i <= 8;
          let stream: MockMediaStream | null = null;

          if (isStreaming) {
            stream = makeStream(`stream-${pid}`);
            streamingMediaMap.set(pid, stream);
            stateStore.subscribedStreams.add(pid);
          }

          slots.push({
            peerId: pid,
            senderName: `Participant ${i}`,
            color: `hsl(${i * 15}, 65%, 45%)`,
            isStreaming,
            isLocal: false,
            stream: stream as any,
          });
        }

        stateStore.roomSlots = slots;

        // Perform initial render
        env.renderer.renderRoomCards();

        assert.strictEqual(env.gridWrapper.children.length, 25, 'Total cards in gridWrapper must be 25');
        const initialCards = [...env.gridWrapper.children];

        // Reconcile 20 consecutive times without modifying state
        for (let r = 0; r < 20; r++) {
          env.renderer.renderRoomCards();
          assert.strictEqual(env.gridWrapper.children.length, 25);
          for (let i = 0; i < 25; i++) {
            assert.strictEqual(
              env.gridWrapper.children[i],
              initialCards[i],
              `Card index ${i} must retain referential identity across re-render ${r + 1}`
            );
          }
        }

        // Verify exactly 8 <video> tags exist and match streaming peers
        let videoTagCount = 0;
        env.gridWrapper.children.forEach((card) => {
          const v = (card as MockElement).querySelector('video');
          if (v) videoTagCount++;
        });
        assert.strictEqual(videoTagCount, 8, 'Exactly 8 video elements must be present for the 8 streaming peers');
      } finally {
        env.cleanup();
      }
    });

    it('5.2: Mass Dynamic Churn: 12-Peer Burst Leave & 12-Peer Burst Join', () => {
      const env = createRoomTestEnvironment();
      try {
        const slots: RoomSlotInfo[] = [];
        for (let i = 1; i <= 25; i++) {
          slots.push({
            peerId: `churn-peer-${i}`,
            senderName: `Peer ${i}`,
            color: 'hsl(180, 65%, 45%)',
            isStreaming: false,
            isLocal: i === 1,
          });
        }

        stateStore.roomSlots = slots;
        env.renderer.renderRoomCards();
        assert.strictEqual(env.gridWrapper.children.length, 25);

        // 1. Burst leave: Peers 14 through 25 leave (12 peers depart)
        stateStore.roomSlots = slots.slice(0, 13);
        env.renderer.renderRoomCards();

        assert.strictEqual(env.gridWrapper.children.length, 13);
        const remainingPids = env.gridWrapper.children.map((c) => (c as MockElement).attributes.get('data-peer-id'));
        for (let i = 1; i <= 13; i++) {
          assert.ok(remainingPids.includes(`churn-peer-${i}`));
        }
        for (let i = 14; i <= 25; i++) {
          assert.ok(!remainingPids.includes(`churn-peer-${i}`), `Departed peer ${i} must be pruned from DOM`);
        }

        // 2. Burst join: 12 new peers join (new-peer-26 through 37)
        const newSlots: RoomSlotInfo[] = [...stateStore.roomSlots];
        for (let i = 26; i <= 37; i++) {
          newSlots.push({
            peerId: `new-peer-${i}`,
            senderName: `New Peer ${i}`,
            color: 'hsl(90, 65%, 45%)',
            isStreaming: false,
            isLocal: false,
          });
        }

        stateStore.roomSlots = newSlots;
        env.renderer.renderRoomCards();

        assert.strictEqual(env.gridWrapper.children.length, 25, 'Total cards must restore to 25 after burst join');
      } finally {
        env.cleanup();
      }
    });

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

        // Motion contentHint applied
        const track = stream.getVideoTracks()[0];
        assert.strictEqual((track as any).contentHint, 'motion');

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
