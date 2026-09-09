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
import type { RoomSlotInfo } from '../../src/core/types.ts';

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

  // Clean initial state
  stateStore.roomSlots = [];
  stateStore.pinnedPeerId = null;
  stateStore.layoutMode = 'grid';
  stateStore.subscribedStreams.clear();
  audioContextManager.cleanup();

  const callbacks = {
    onRequestStream: (_peerId: string) => {},
    onStopWatchingStream: (_peerId: string) => {},
    getPeerPing: (_peerId: string) => 20,
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

function makeStream(id: string, hasAudio: boolean = true): MockMediaStream {
  const stream = new MockMediaStream(id);
  stream.addTrack(new MockMediaStreamTrack('video', `${id}-video`));
  if (hasAudio) {
    stream.addTrack(new MockMediaStreamTrack('audio', `${id}-audio`));
  }
  return stream;
}

describe('M5 Adversarial Challenge: Keyed DOM Reconciliation & Video Playback Stability', () => {
  describe('Challenge 1: Referential Stability Under 50x Rapid Re-Renders', () => {
    it('should maintain strictly identical <video> references and zero redundant play() calls across 50 consecutive renders', () => {
      const env = createRoomTestEnvironment();
      try {
        const peerCount = 6;
        const streams: MockMediaStream[] = [];
        const slots: RoomSlotInfo[] = [];

        // 1 Local streaming peer + 5 Remote streaming peers
        const localStream = makeStream('local-stream', false);
        streams.push(localStream);
        slots.push({
          peerId: 'local-peer',
          senderName: 'Local User',
          color: '#00ffff',
          isStreaming: true,
          isLocal: true,
          stream: localStream as any,
          watchers: [],
        });

        for (let i = 1; i < peerCount; i++) {
          const s = makeStream(`stream-${i}`, true);
          streams.push(s);
          const peerId = `remote-peer-${i}`;
          slots.push({
            peerId,
            senderName: `Remote Peer ${i}`,
            color: `#ff${i}${i}00`,
            isStreaming: true,
            isLocal: false,
            stream: s as any,
            watchers: [{ peerId: 'local-peer', username: 'Local User' }],
          });
          stateStore.subscribedStreams.add(peerId);
        }

        stateStore.roomSlots = slots;

        // Initial render (Pass 0)
        env.renderer.renderRoomCards();

        assert.equal(env.gridWrapper.children.length, peerCount, 'Grid must contain all 6 initial cards');

        const initialCards: MockElement[] = [];
        const initialVideos: MockVideoElement[] = [];

        for (let i = 0; i < peerCount; i++) {
          const card = env.gridWrapper.children[i] as MockElement;
          assert.ok(card, `Card ${i} must exist`);
          const video = card.querySelector('video') as MockVideoElement;
          assert.ok(video, `Video element ${i} must exist`);
          assert.equal(video.playCount, 1, `Video ${i} must have playCount = 1 initially`);
          assert.equal(video.paused, false, `Video ${i} must be playing`);
          assert.strictEqual(video.srcObject, streams[i], `Video ${i} srcObject must match stream`);

          initialCards.push(card);
          initialVideos.push(video);
        }

        // Stress: 50 rapid consecutive re-renders with identical slots
        const iterations = 50;
        for (let round = 1; round <= iterations; round++) {
          env.renderer.renderRoomCards();

          assert.equal(
            env.gridWrapper.children.length,
            peerCount,
            `Round ${round}: Grid child count must remain ${peerCount}`
          );

          for (let i = 0; i < peerCount; i++) {
            const currentCard = env.gridWrapper.children[i] as MockElement;
            const currentVideo = currentCard.querySelector('video') as MockVideoElement;

            // Strict referential equality assertion: NO object churn
            assert.strictEqual(
              currentCard,
              initialCards[i],
              `Round ${round}, Peer ${i}: Card DOM node must be strictly identical reference`
            );
            assert.strictEqual(
              currentVideo,
              initialVideos[i],
              `Round ${round}, Peer ${i}: Video element must be strictly identical reference`
            );

            // Playback idempotency: play() must NOT be invoked redundantly
            assert.equal(
              currentVideo.playCount,
              1,
              `Round ${round}, Peer ${i}: video.play() must NOT be called redundantly (playCount must stay 1)`
            );
            assert.equal(
              currentVideo.paused,
              false,
              `Round ${round}, Peer ${i}: video must remain actively playing without pause`
            );
            assert.equal(
              currentVideo.loadCount,
              0,
              `Round ${round}, Peer ${i}: video.load() must NOT be called during steady-state render`
            );
            assert.strictEqual(
              currentVideo.srcObject,
              streams[i],
              `Round ${round}, Peer ${i}: video.srcObject must NOT be reassigned`
            );
          }
        }
      } finally {
        env.cleanup();
      }
    });
  });

  describe('Challenge 2: Dynamic Peer Join and Leave Isolation in 6-Participant Room', () => {
    it('should isolate dynamic additions and removals without disturbing unaffected peer video streams', () => {
      const env = createRoomTestEnvironment();
      try {
        const streams = new Map<string, MockMediaStream>();
        const getOrMakeStream = (id: string) => {
          if (!streams.has(id)) streams.set(id, makeStream(id, true));
          return streams.get(id)!;
        };

        // Initialize 6 participants (P1..P6)
        stateStore.roomSlots = [
          { peerId: 'p1', senderName: 'Peer 1', color: '#111', isStreaming: true, isLocal: true, stream: getOrMakeStream('s1') as any },
          { peerId: 'p2', senderName: 'Peer 2', color: '#222', isStreaming: true, isLocal: false, stream: getOrMakeStream('s2') as any },
          { peerId: 'p3', senderName: 'Peer 3', color: '#333', isStreaming: true, isLocal: false, stream: getOrMakeStream('s3') as any },
          { peerId: 'p4', senderName: 'Peer 4', color: '#444', isStreaming: true, isLocal: false, stream: getOrMakeStream('s4') as any },
          { peerId: 'p5', senderName: 'Peer 5', color: '#555', isStreaming: true, isLocal: false, stream: getOrMakeStream('s5') as any },
          { peerId: 'p6', senderName: 'Peer 6', color: '#666', isStreaming: true, isLocal: false, stream: getOrMakeStream('s6') as any },
        ];
        ['p2', 'p3', 'p4', 'p5', 'p6'].forEach((id) => stateStore.subscribedStreams.add(id));

        env.renderer.renderRoomCards();
        assert.equal(env.gridWrapper.children.length, 6);

        // Snapshot initial card and video references
        const savedCards = new Map<string, MockElement>();
        const savedVideos = new Map<string, MockVideoElement>();

        for (const child of env.gridWrapper.children) {
          const peerId = child.getAttribute('data-peer-id')!;
          const vid = child.querySelector('video') as MockVideoElement;
          assert.ok(peerId && vid);
          savedCards.set(peerId, child);
          savedVideos.set(peerId, vid);
          assert.equal(vid.playCount, 1);
        }

        // --- Step 2A: Dynamic Join of Peer 7 ---
        stateStore.roomSlots.push({
          peerId: 'p7',
          senderName: 'Peer 7',
          color: '#777',
          isStreaming: true,
          isLocal: false,
          stream: getOrMakeStream('s7') as any,
        });
        stateStore.subscribedStreams.add('p7');

        env.renderer.renderRoomCards();
        assert.equal(env.gridWrapper.children.length, 7, 'Grid now holds 7 cards');

        // Verify unaffected peers P1..P6 remain intact
        for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
          const card = savedCards.get(id)!;
          const vid = savedVideos.get(id)!;
          assert.strictEqual(
            env.gridWrapper.querySelector(`[data-peer-id="${id}"]`),
            card,
            `Peer ${id} card DOM node reference preserved`
          );
          assert.strictEqual(
            card.querySelector('video'),
            vid,
            `Peer ${id} video element reference preserved`
          );
          assert.equal(vid.playCount, 1, `Peer ${id} playCount must stay 1`);
          assert.equal(vid.paused, false, `Peer ${id} video must still be playing`);
        }

        // Verify P7 is initialized
        const p7Card = env.gridWrapper.querySelector('[data-peer-id="p7"]') as MockElement;
        assert.ok(p7Card);
        const p7Video = p7Card.querySelector('video') as MockVideoElement;
        assert.ok(p7Video);
        assert.equal(p7Video.playCount, 1);

        // --- Step 2B: Dynamic Leave of Peer 3 (middle peer) ---
        stateStore.roomSlots = stateStore.roomSlots.filter((s) => s.peerId !== 'p3');
        stateStore.subscribedStreams.delete('p3');

        env.renderer.renderRoomCards();
        assert.equal(env.gridWrapper.children.length, 6, 'Grid now holds 6 cards after p3 departure');
        assert.equal(env.gridWrapper.querySelector('[data-peer-id="p3"]'), null, 'p3 card removed from DOM');

        // Check P3 GPU cleanup
        const p3Video = savedVideos.get('p3')!;
        assert.equal(p3Video.paused, true, 'Departed p3 video paused');
        assert.equal(p3Video.srcObject, null, 'Departed p3 video srcObject nullified');
        assert.ok(p3Video.loadCount > 0, 'Departed p3 video load() called for GPU surface disposal');

        // Verify remaining peers P1, P2, P4, P5, P6, P7 are completely untouched
        for (const id of ['p1', 'p2', 'p4', 'p5', 'p6']) {
          const card = savedCards.get(id)!;
          const vid = savedVideos.get(id)!;
          assert.strictEqual(
            env.gridWrapper.querySelector(`[data-peer-id="${id}"]`),
            card,
            `Peer ${id} card DOM node reference preserved after p3 left`
          );
          assert.strictEqual(
            card.querySelector('video'),
            vid,
            `Peer ${id} video element reference preserved after p3 left`
          );
          assert.equal(vid.playCount, 1, `Peer ${id} playCount still 1`);
          assert.equal(vid.paused, false, `Peer ${id} video still playing`);
        }

        // --- Step 2C: Dynamic Leave of Peer 1 (first element in list) ---
        stateStore.roomSlots = stateStore.roomSlots.filter((s) => s.peerId !== 'p1');

        env.renderer.renderRoomCards();
        assert.equal(env.gridWrapper.children.length, 5, 'Grid now holds 5 cards after p1 departure');

        const p1Video = savedVideos.get('p1')!;
        assert.equal(p1Video.paused, true, 'p1 paused');
        assert.equal(p1Video.srcObject, null, 'p1 detached');

        for (const id of ['p2', 'p4', 'p5', 'p6']) {
          const card = savedCards.get(id)!;
          const vid = savedVideos.get(id)!;
          assert.strictEqual(
            env.gridWrapper.querySelector(`[data-peer-id="${id}"]`),
            card,
            `Peer ${id} card DOM node preserved after p1 left`
          );
          assert.strictEqual(
            card.querySelector('video'),
            vid,
            `Peer ${id} video preserved after p1 left`
          );
          assert.equal(vid.playCount, 1);
        }

        // --- Step 2D: Peer 3 Re-joins ---
        const newStream3 = makeStream('s3-new', true);
        stateStore.roomSlots.push({
          peerId: 'p3',
          senderName: 'Peer 3 Returned',
          color: '#333',
          isStreaming: true,
          isLocal: false,
          stream: newStream3 as any,
        });
        stateStore.subscribedStreams.add('p3');

        env.renderer.renderRoomCards();
        assert.equal(env.gridWrapper.children.length, 6);

        const rejoinedP3Card = env.gridWrapper.querySelector('[data-peer-id="p3"]') as MockElement;
        assert.ok(rejoinedP3Card);
        const rejoinedP3Video = rejoinedP3Card.querySelector('video') as MockVideoElement;
        assert.ok(rejoinedP3Video);
        assert.strictEqual(rejoinedP3Video.srcObject, newStream3);
        assert.equal(rejoinedP3Video.playCount, 1);

        // Siblings still unchanged
        for (const id of ['p2', 'p4', 'p5', 'p6']) {
          const card = savedCards.get(id)!;
          const vid = savedVideos.get(id)!;
          assert.strictEqual(env.gridWrapper.querySelector(`[data-peer-id="${id}"]`), card);
          assert.strictEqual(card.querySelector('video'), vid);
          assert.equal(vid.playCount, 1);
        }
      } finally {
        env.cleanup();
      }
    });
  });

  describe('Challenge 3: Rapid Mode Toggling (100x Grid <-> Spotlight Switches)', () => {
    it('should maintain strictly bounded cachedCards.size, exactly 1 card per peer, and zero duplicate elements', () => {
      const env = createRoomTestEnvironment();
      try {
        const peerCount = 6;
        const slots: RoomSlotInfo[] = [];
        const originalVideos = new Map<string, MockVideoElement>();

        for (let i = 0; i < peerCount; i++) {
          const peerId = `peer-${i}`;
          const isLocal = i === 0;
          const stream = makeStream(`stream-${i}`, !isLocal);
          slots.push({
            peerId,
            senderName: isLocal ? 'Host' : `Viewer ${i}`,
            color: `#${i}${i}${i}`,
            isStreaming: true,
            isLocal,
            stream: stream as any,
          });
          if (!isLocal) {
            stateStore.subscribedStreams.add(peerId);
          }
        }
        stateStore.roomSlots = slots;

        // Render initially in Grid mode
        stateStore.layoutMode = 'grid';
        stateStore.pinnedPeerId = null;
        env.renderer.renderRoomCards();

        const cachedCardsMap = (env.renderer as any).cachedCards as Map<string, any>;
        assert.equal(cachedCardsMap.size, peerCount, 'Initial cache must contain exactly 6 entries');

        for (let i = 0; i < peerCount; i++) {
          const peerId = `peer-${i}`;
          const card = env.gridWrapper.querySelector(`[data-peer-id="${peerId}"]`) as MockElement;
          assert.ok(card, `Card for ${peerId} must exist`);
          const vid = card.querySelector('video') as MockVideoElement;
          assert.ok(vid, `Video for ${peerId} must exist`);
          originalVideos.set(peerId, vid);
          assert.equal(vid.playCount, 1);
        }

        // Stress: 100 rapid mode toggles
        const targetToggles = 100;
        for (let t = 0; t < targetToggles; t++) {
          if (t % 2 === 0) {
            // Switch to Spotlight: rotate pinned peer among peers 1..5
            const pinnedIdx = 1 + (t % (peerCount - 1));
            const pinnedId = `peer-${pinnedIdx}`;
            stateStore.layoutMode = 'spotlight';
            stateStore.pinnedPeerId = pinnedId;
            env.renderer.renderRoomCards();

            // Assertions for Spotlight mode
            assert.equal(
              cachedCardsMap.size,
              peerCount,
              `Toggle ${t} [Spotlight]: cachedCards.size must stay bounded at ${peerCount}`
            );
            assert.equal(
              env.featuredArea.children.length,
              1,
              `Toggle ${t} [Spotlight]: featuredArea must contain exactly 1 card`
            );
            assert.equal(
              env.trayStrip.children.length,
              peerCount - 1,
              `Toggle ${t} [Spotlight]: trayStrip must contain ${peerCount - 1} cards`
            );
            assert.equal(
              env.gridWrapper.children.length,
              0,
              `Toggle ${t} [Spotlight]: gridWrapper must have 0 cards`
            );

            // Check featured card has .featured class
            const featuredCard = env.featuredArea.children[0] as MockElement;
            assert.equal(
              featuredCard.getAttribute('data-peer-id'),
              pinnedId,
              `Toggle ${t}: Pinned peer ${pinnedId} must be in featuredArea`
            );
            assert.equal(
              featuredCard.classList.contains('featured'),
              true,
              `Toggle ${t}: Featured card must have 'featured' class`
            );
          } else {
            // Switch to Grid
            stateStore.layoutMode = 'grid';
            stateStore.pinnedPeerId = null;
            env.renderer.renderRoomCards();

            // Assertions for Grid mode
            assert.equal(
              cachedCardsMap.size,
              peerCount,
              `Toggle ${t} [Grid]: cachedCards.size must stay bounded at ${peerCount}`
            );
            assert.equal(
              env.gridWrapper.children.length,
              peerCount,
              `Toggle ${t} [Grid]: gridWrapper must contain all ${peerCount} cards`
            );
            assert.equal(
              env.featuredArea.children.length,
              0,
              `Toggle ${t} [Grid]: featuredArea must be empty`
            );
            assert.equal(
              env.trayStrip.children.length,
              0,
              `Toggle ${t} [Grid]: trayStrip must be empty`
            );
          }

          // Invariant across ALL toggles: exactly 1 card per peer in the active containers
          for (let i = 0; i < peerCount; i++) {
            const peerId = `peer-${i}`;
            const inGrid = env.gridWrapper.querySelectorAll(`[data-peer-id="${peerId}"]`).length;
            const inFeat = env.featuredArea.querySelectorAll(`[data-peer-id="${peerId}"]`).length;
            const inTray = env.trayStrip.querySelectorAll(`[data-peer-id="${peerId}"]`).length;
            const totalMatches = inGrid + inFeat + inTray;
            assert.equal(
              totalMatches,
              1,
              `Toggle ${t}: Exactly 1 DOM element must exist for ${peerId} (found ${totalMatches}: grid=${inGrid}, feat=${inFeat}, tray=${inTray})`
            );
          }
        }

        // Final verification: Switch back to Grid
        stateStore.layoutMode = 'grid';
        stateStore.pinnedPeerId = null;
        env.renderer.renderRoomCards();

        assert.equal(cachedCardsMap.size, peerCount);
        assert.equal(env.gridWrapper.children.length, peerCount);

        // Verify video element referential stability across the entire 100 switches
        for (let i = 0; i < peerCount; i++) {
          const peerId = `peer-${i}`;
          const card = env.gridWrapper.querySelector(`[data-peer-id="${peerId}"]`) as MockElement;
          const vid = card.querySelector('video') as MockVideoElement;
          const originalVid = originalVideos.get(peerId)!;

          assert.strictEqual(
            vid,
            originalVid,
            `Peer ${peerId}: Video element reference must survive 100 mode switches without recreation`
          );
          assert.equal(
            vid.playCount,
            1,
            `Peer ${peerId}: video.play() must NOT be called repeatedly on layout toggles (playCount=${vid.playCount})`
          );
          assert.equal(
            vid.paused,
            false,
            `Peer ${peerId}: video must remain playing continuously`
          );
        }
      } finally {
        env.cleanup();
      }
    });
  });

  describe('Challenge 4: High-Concurrency & Rapid Sub-Mode State Transitions', () => {
    it('4A: should scale smoothly to 20 concurrent streaming peers without duplicate DOM nodes or AudioContext leaks', () => {
      const env = createRoomTestEnvironment();
      try {
        MockAudioContext.instanceCount = 0;
        const totalPeers = 20;
        const slots: RoomSlotInfo[] = [];

        for (let i = 1; i <= totalPeers; i++) {
          const peerId = `streamer-${i}`;
          const stream = makeStream(`stream-${i}`, true);
          slots.push({
            peerId,
            senderName: `Streamer ${i}`,
            color: '#333333',
            isStreaming: true,
            isLocal: false,
            stream: stream as any,
          });
          stateStore.subscribedStreams.add(peerId);
        }
        stateStore.roomSlots = slots;

        env.renderer.renderRoomCards();

        assert.equal(env.gridWrapper.children.length, totalPeers);
        assert.equal(MockAudioContext.instanceCount, 1, 'Strictly 1 AudioContext instantiated for 20 streams');

        const cachedCardsMap = (env.renderer as any).cachedCards as Map<string, any>;
        assert.equal(cachedCardsMap.size, totalPeers);

        // Spot-check spotlight on streamer 15
        stateStore.layoutMode = 'spotlight';
        stateStore.pinnedPeerId = 'streamer-15';
        env.renderer.renderRoomCards();

        assert.equal(env.featuredArea.children.length, 1);
        assert.equal(env.featuredArea.children[0]!.getAttribute('data-peer-id'), 'streamer-15');
        assert.equal(env.trayStrip.children.length, totalPeers - 1);
        assert.equal(cachedCardsMap.size, totalPeers);
      } finally {
        env.cleanup();
      }
    });

    it('4B: should handle 50 rapid video <-> avatar streaming toggle cycles with zero leaked video elements', () => {
      const env = createRoomTestEnvironment();
      try {
        const stream = makeStream('flapping-stream', true);
        const slot: RoomSlotInfo = {
          peerId: 'flapper',
          senderName: 'Flapping Peer',
          color: '#ffaa00',
          isStreaming: true,
          isLocal: false,
          stream: stream as any,
        };
        stateStore.roomSlots = [slot];
        stateStore.subscribedStreams.add('flapper');

        const cycles = 50;
        for (let c = 0; c < cycles; c++) {
          // Stop streaming (turns into participant-card avatar)
          slot.isStreaming = false;
          slot.stream = null;
          env.renderer.renderRoomCards();

          const cardAvatar = env.gridWrapper.children[0] as MockElement;
          assert.ok(cardAvatar.classList.contains('participant-card'));
          assert.equal(cardAvatar.querySelector('video'), null, `Cycle ${c}: No video in avatar mode`);

          // Resume streaming (turns into stream-card with video)
          slot.isStreaming = true;
          slot.stream = stream as any;
          env.renderer.renderRoomCards();

          const cardVideo = env.gridWrapper.children[0] as MockElement;
          assert.ok(cardVideo.classList.contains('stream-card'));
          const vid = cardVideo.querySelector('video') as MockVideoElement;
          assert.ok(vid, `Cycle ${c}: Video must exist when streaming`);
          assert.strictEqual(vid.srcObject, stream);
        }

        const cachedCardsMap = (env.renderer as any).cachedCards as Map<string, any>;
        assert.equal(cachedCardsMap.size, 1, 'Cache map must contain strictly 1 card at end of 50 cycles');
      } finally {
        env.cleanup();
      }
    });

    it('4C: should preserve video element referential identity across slot re-orderings (permutations)', () => {
      const env = createRoomTestEnvironment();
      try {
        const streamA = makeStream('stream-a');
        const streamB = makeStream('stream-b');
        const streamC = makeStream('stream-c');

        const slotA: RoomSlotInfo = { peerId: 'pA', senderName: 'Alice', color: '#f00', isStreaming: true, isLocal: false, stream: streamA as any };
        const slotB: RoomSlotInfo = { peerId: 'pB', senderName: 'Bob', color: '#0f0', isStreaming: true, isLocal: false, stream: streamB as any };
        const slotC: RoomSlotInfo = { peerId: 'pC', senderName: 'Charlie', color: '#00f', isStreaming: true, isLocal: false, stream: streamC as any };

        ['pA', 'pB', 'pC'].forEach((id) => stateStore.subscribedStreams.add(id));

        // Initial order: [A, B, C]
        stateStore.roomSlots = [slotA, slotB, slotC];
        env.renderer.renderRoomCards();

        const cardA = env.gridWrapper.children[0] as MockElement;
        const videoA = cardA.querySelector('video') as MockVideoElement;
        const cardB = env.gridWrapper.children[1] as MockElement;
        const videoB = cardB.querySelector('video') as MockVideoElement;
        const cardC = env.gridWrapper.children[2] as MockElement;
        const videoC = cardC.querySelector('video') as MockVideoElement;

        // Permutation 1: Reversed [C, B, A]
        stateStore.roomSlots = [slotC, slotB, slotA];
        env.renderer.renderRoomCards();

        assert.strictEqual(env.gridWrapper.children[0], cardC, 'Pos 0 is Card C');
        assert.strictEqual(env.gridWrapper.children[1], cardB, 'Pos 1 is Card B');
        assert.strictEqual(env.gridWrapper.children[2], cardA, 'Pos 2 is Card A');

        assert.strictEqual(cardC.querySelector('video'), videoC);
        assert.strictEqual(cardB.querySelector('video'), videoB);
        assert.strictEqual(cardA.querySelector('video'), videoA);

        // Permutation 2: Rotated [B, C, A]
        stateStore.roomSlots = [slotB, slotC, slotA];
        env.renderer.renderRoomCards();

        assert.strictEqual(env.gridWrapper.children[0], cardB);
        assert.strictEqual(env.gridWrapper.children[1], cardC);
        assert.strictEqual(env.gridWrapper.children[2], cardA);

        // Video play count still 1 for all peers despite re-orderings
        assert.equal(videoA.playCount, 1);
        assert.equal(videoB.playCount, 1);
        assert.equal(videoC.playCount, 1);
      } finally {
        env.cleanup();
      }
    });

    it('4D: should cleanly update srcObject in-place upon stream renegotiation without replacing card DOM node', () => {
      const env = createRoomTestEnvironment();
      try {
        const initialStream = makeStream('stream-initial');
        const slot: RoomSlotInfo = {
          peerId: 'peer-reneg',
          senderName: 'Renegotiator',
          color: '#abcdef',
          isStreaming: true,
          isLocal: false,
          stream: initialStream as any,
        };
        stateStore.roomSlots = [slot];
        stateStore.subscribedStreams.add('peer-reneg');

        env.renderer.renderRoomCards();

        const card = env.gridWrapper.children[0] as MockElement;
        const video = card.querySelector('video') as MockVideoElement;
        assert.strictEqual(video.srcObject, initialStream);
        assert.equal(video.playCount, 1);

        // Peer renegotiates: new MediaStream instance arrives
        const renegotiatedStream = makeStream('stream-renegotiated');
        slot.stream = renegotiatedStream as any;

        env.renderer.renderRoomCards();

        const cardAfter = env.gridWrapper.children[0] as MockElement;
        const videoAfter = cardAfter.querySelector('video') as MockVideoElement;

        assert.strictEqual(cardAfter, card, 'Card element identity must be preserved across stream renegotiation');
        assert.strictEqual(videoAfter, video, 'Video element identity must be preserved across stream renegotiation');
        assert.strictEqual(videoAfter.srcObject, renegotiatedStream, 'srcObject updated to new stream');
        assert.equal(videoAfter.playCount, 2, 'play() invoked once more to restart decoding on new stream');
      } finally {
        env.cleanup();
      }
    });

    it('4E: should handle 30 rapid unsubscribe and resubscribe user clicks without memory or DOM element leaks', () => {
      const env = createRoomTestEnvironment();
      try {
        const stream = makeStream('churn-stream');
        const slot: RoomSlotInfo = {
          peerId: 'churn-peer',
          senderName: 'Churner',
          color: '#123456',
          isStreaming: true,
          isLocal: false,
          stream: stream as any,
        };
        stateStore.roomSlots = [slot];
        stateStore.subscribedStreams.add('churn-peer');

        for (let i = 0; i < 30; i++) {
          // Render subscribed state
          env.renderer.renderRoomCards();
          const cardSub = env.gridWrapper.children[0] as MockElement;
          const stopBtn = cardSub.querySelector('.btn-stop-watch-stream') as MockElement;
          assert.ok(stopBtn, `Iteration ${i}: Stop button present`);

          // Click "Parar de Assistir"
          stopBtn.click();

          // Now unsubscribed
          assert.equal(stateStore.subscribedStreams.has('churn-peer'), false);
          const cardUnsub = env.gridWrapper.children[0] as MockElement;
          assert.ok(cardUnsub.classList.contains('participant-card'));
          const watchBtn = cardUnsub.querySelector('.btn-watch-stream') as MockElement;
          assert.ok(watchBtn, `Iteration ${i}: Watch button present`);

          // Click "Assistir Transmissão"
          watchBtn.click();
          assert.equal(stateStore.subscribedStreams.has('churn-peer'), true);
        }

        // Final verification: 1 card, 1 video, bounded cache
        const cachedCardsMap = (env.renderer as any).cachedCards as Map<string, any>;
        assert.equal(cachedCardsMap.size, 1);
        assert.equal(env.gridWrapper.children.length, 1);
      } finally {
        env.cleanup();
      }
    });
  });
});
