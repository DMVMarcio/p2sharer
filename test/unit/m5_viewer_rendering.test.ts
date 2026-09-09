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

describe('M5 Unit Tests: Viewer Decoding & Dynamic Multi-Stream Rendering', () => {
  describe('Suite 1: Keyed In-Place DOM Reconciliation & Video Element Referential Identity', () => {
    it('1.1: should preserve identical <video> element instance across consecutive re-renders with identical slots', () => {
      const env = createRoomTestEnvironment();
      try {
        const stream1 = makeStream('stream-1');
        const slot: RoomSlotInfo = {
          peerId: 'peer1',
          senderName: 'Alice',
          color: '#ff4444',
          isStreaming: true,
          isLocal: false,
          stream: stream1 as any,
        };

        stateStore.roomSlots = [slot];
        stateStore.subscribedStreams.add('peer1');

        env.renderer.renderRoomCards();

        const cardA = env.gridWrapper.children[0] as MockElement;
        assert.ok(cardA, 'Card must be created');
        const videoA = cardA.querySelector('video') as MockVideoElement;
        assert.ok(videoA, 'Video element must exist');
        assert.equal(videoA.playCount, 1, 'Initial play() called');
        assert.strictEqual(videoA.srcObject, stream1);

        // Consecutive re-render with unchanged slot
        env.renderer.renderRoomCards();

        const cardB = env.gridWrapper.children[0] as MockElement;
        const videoB = cardB.querySelector('video') as MockVideoElement;

        assert.strictEqual(cardA, cardB, 'Card DOM node must be referentially identical');
        assert.strictEqual(videoA, videoB, 'Video element instance must be referentially identical');
        assert.equal(videoB.playCount, 1, 'play() must NOT be re-called when stream is identical');
        assert.strictEqual(videoB.srcObject, stream1, 'srcObject must NOT be re-assigned');
      } finally {
        env.cleanup();
      }
    });

    it('1.2: should mutate metadata in-place without re-creating DOM nodes', () => {
      const env = createRoomTestEnvironment();
      try {
        const stream1 = makeStream('stream-1');
        const slot: RoomSlotInfo = {
          peerId: 'peer1',
          senderName: 'Alice',
          color: '#ff4444',
          isStreaming: true,
          isLocal: false,
          stream: stream1 as any,
          watchers: [{ peerId: 'w1', username: 'Bob' }],
        };

        stateStore.roomSlots = [slot];
        stateStore.subscribedStreams.add('peer1');

        env.renderer.renderRoomCards();
        const cardInitial = env.gridWrapper.children[0] as MockElement;
        const videoInitial = cardInitial.querySelector('video');

        // Mutate metadata
        stateStore.roomSlots[0]!.senderName = 'Alice Pro';
        stateStore.roomSlots[0]!.watchers = [
          { peerId: 'w1', username: 'Bob' },
          { peerId: 'w2', username: 'Charlie' },
          { peerId: 'w3', username: 'Dave' },
        ];

        env.renderer.renderRoomCards();

        const cardUpdated = env.gridWrapper.children[0] as MockElement;
        const videoUpdated = cardUpdated.querySelector('video');

        assert.strictEqual(cardInitial, cardUpdated, 'Card element must not be replaced');
        assert.strictEqual(videoInitial, videoUpdated, 'Video element must not be replaced');

        const nameSpan = (cardUpdated.querySelector('.stream-user-name') ||
          cardUpdated.querySelector('.stream-card-overlay span:nth-child(2)')) as MockElement | null;
        assert.equal(nameSpan?.textContent, 'Alice Pro', 'Name overlay must update in-place');

        const watchersSpan = cardUpdated.querySelector('.stat-watchers-text');
        assert.equal(watchersSpan?.textContent, '3 assistindo', 'Watchers count must update in-place');
      } finally {
        env.cleanup();
      }
    });
  });

  describe('Suite 2: Dynamic Peer Lifecycle (Join & Leave Isolation)', () => {
    it('2.1: should isolate peer join: adding a new peer does not recreate or disturb existing peer video elements', () => {
      const env = createRoomTestEnvironment();
      try {
        const localStream = makeStream('local-stream');
        const peer1Stream = makeStream('peer1-stream');

        stateStore.roomSlots = [
          { peerId: 'local', senderName: 'Me', color: '#00ccff', isStreaming: true, isLocal: true, stream: localStream as any },
          { peerId: 'peer1', senderName: 'Alice', color: '#ff4444', isStreaming: true, isLocal: false, stream: peer1Stream as any },
        ];
        stateStore.subscribedStreams.add('peer1');

        env.renderer.renderRoomCards();

        assert.equal(env.gridWrapper.children.length, 2);
        const card1 = env.gridWrapper.children[1] as MockElement;
        const video1 = card1.querySelector('video') as MockVideoElement;
        const initialPlayCount1 = video1.playCount;

        // Peer 2 joins and starts streaming
        const peer2Stream = makeStream('peer2-stream');
        stateStore.roomSlots.push({
          peerId: 'peer2',
          senderName: 'Bob',
          color: '#44ff44',
          isStreaming: true,
          isLocal: false,
          stream: peer2Stream as any,
        });
        stateStore.subscribedStreams.add('peer2');

        env.renderer.renderRoomCards();

        assert.equal(env.gridWrapper.children.length, 3, 'Grid must contain 3 cards');
        const card1After = env.gridWrapper.children[1] as MockElement;
        const video1After = card1After.querySelector('video') as MockVideoElement;

        assert.strictEqual(card1, card1After, 'Peer 1 card element identity preserved');
        assert.strictEqual(video1, video1After, 'Peer 1 video element identity preserved');
        assert.equal(video1After.playCount, initialPlayCount1, 'Peer 1 play count unchanged');

        const card2 = env.gridWrapper.children[2] as MockElement;
        const video2 = card2.querySelector('video') as MockVideoElement;
        assert.ok(video2, 'Peer 2 video element created');
        assert.strictEqual(video2.srcObject, peer2Stream);
      } finally {
        env.cleanup();
      }
    });

    it('2.2: should isolate peer leave: removing a peer removes only their card without disturbing neighboring video streams', () => {
      const env = createRoomTestEnvironment();
      try {
        const peer1Stream = makeStream('peer1-stream');
        const peer2Stream = makeStream('peer2-stream');

        stateStore.roomSlots = [
          { peerId: 'peer1', senderName: 'Alice', color: '#ff4444', isStreaming: true, isLocal: false, stream: peer1Stream as any },
          { peerId: 'peer2', senderName: 'Bob', color: '#44ff44', isStreaming: true, isLocal: false, stream: peer2Stream as any },
        ];
        stateStore.subscribedStreams.add('peer1');
        stateStore.subscribedStreams.add('peer2');

        env.renderer.renderRoomCards();
        assert.equal(env.gridWrapper.children.length, 2);

        const card1 = env.gridWrapper.children[0] as MockElement;
        const video1 = card1.querySelector('video') as MockVideoElement;
        const card2 = env.gridWrapper.children[1] as MockElement;
        const video2 = card2.querySelector('video') as MockVideoElement;

        // Peer 2 departs
        stateStore.roomSlots = [stateStore.roomSlots[0]!];
        stateStore.subscribedStreams.delete('peer2');

        env.renderer.renderRoomCards();

        assert.equal(env.gridWrapper.children.length, 1, 'Only 1 card remains in grid');
        assert.strictEqual(env.gridWrapper.children[0], card1, 'Peer 1 card intact');
        assert.strictEqual(card1.querySelector('video'), video1, 'Peer 1 video untouched');

        // Peer 2 GPU cleanup verified
        assert.equal(video2.paused, true, 'Departed peer video paused');
        assert.equal(video2.srcObject, null, 'Departed peer srcObject detached');
        assert.ok(video2.loadCount > 0, 'Departed peer load() called to free GPU surface');
      } finally {
        env.cleanup();
      }
    });
  });

  describe('Suite 3: Elimination of Dual Card Caching', () => {
    it('3.1: should maintain strictly ONE card and ONE <video> element per peer across layout modes', () => {
      const env = createRoomTestEnvironment();
      try {
        const stream1 = makeStream('stream-1');
        stateStore.roomSlots = [
          { peerId: 'peer1', senderName: 'Alice', color: '#ff4444', isStreaming: true, isLocal: false, stream: stream1 as any },
        ];
        stateStore.subscribedStreams.add('peer1');

        // 1. Grid Mode
        stateStore.layoutMode = 'grid';
        env.renderer.renderRoomCards();

        const cachedCardsMap = (env.renderer as any).cachedCards as Map<string, any>;
        assert.equal(cachedCardsMap.size, 1, 'Exactly 1 card cached in Grid mode');
        assert.ok(cachedCardsMap.has('peer1'), 'Cached key must be peerId without :feat or :norm suffix');

        const cardGrid = env.gridWrapper.children[0] as MockElement;
        const videoGrid = cardGrid.querySelector('video') as MockVideoElement;

        // 2. Spotlight Mode (Peer 1 pinned)
        stateStore.layoutMode = 'spotlight';
        stateStore.pinnedPeerId = 'peer1';
        env.renderer.renderRoomCards();

        assert.equal(cachedCardsMap.size, 1, 'Still strictly 1 card cached in Spotlight mode');
        const cardFeatured = env.featuredArea.children[0] as MockElement;
        const videoFeatured = cardFeatured.querySelector('video') as MockVideoElement;

        assert.strictEqual(cardFeatured, cardGrid, 'Same card DOM element reparented into featuredArea');
        assert.strictEqual(videoFeatured, videoGrid, 'Same video element preserved without recreation');
        assert.equal(cardFeatured.classList.contains('featured'), true, 'Card dynamically tagged with .featured');

        // 3. Return to Grid Mode
        stateStore.layoutMode = 'grid';
        stateStore.pinnedPeerId = null;
        env.renderer.renderRoomCards();

        assert.equal(cachedCardsMap.size, 1, 'Cache remains strictly 1 card on return to Grid');
        const cardReturn = env.gridWrapper.children[0] as MockElement;
        const videoReturn = cardReturn.querySelector('video') as MockVideoElement;

        assert.strictEqual(cardReturn, cardGrid, 'Same card element reparented back to gridWrapper');
        assert.strictEqual(videoReturn, videoGrid, 'Same video element instance preserved');
        assert.equal(cardReturn.classList.contains('featured'), false, '.featured class removed in grid');
      } finally {
        env.cleanup();
      }
    });
  });

  describe('Suite 4: Spotlight Layout Mode Partitioning & Transitions', () => {
    it('4.1: should partition featured peer into stage and other peers into tray strip', () => {
      const env = createRoomTestEnvironment();
      try {
        const stream1 = makeStream('stream-1');
        const stream2 = makeStream('stream-2');

        stateStore.roomSlots = [
          { peerId: 'local', senderName: 'Me', color: '#00ccff', isStreaming: false, isLocal: true, stream: null },
          { peerId: 'peer1', senderName: 'Alice', color: '#ff4444', isStreaming: true, isLocal: false, stream: stream1 as any },
          { peerId: 'peer2', senderName: 'Bob', color: '#44ff44', isStreaming: true, isLocal: false, stream: stream2 as any },
        ];
        stateStore.subscribedStreams.add('peer1');
        stateStore.subscribedStreams.add('peer2');

        stateStore.layoutMode = 'spotlight';
        stateStore.pinnedPeerId = 'peer1';

        env.renderer.renderRoomCards();

        assert.equal(env.featuredArea.children.length, 1, 'Stage must contain exactly 1 featured card');
        assert.equal(env.featuredArea.children[0]!.getAttribute('data-peer-id'), 'peer1');
        assert.equal(env.featuredArea.children[0]!.classList.contains('featured'), true);

        assert.equal(env.trayStrip.children.length, 2, 'Tray strip must contain the 2 non-featured cards');
        assert.equal(env.trayStrip.children[0]!.getAttribute('data-peer-id'), 'local');
        assert.equal(env.trayStrip.children[1]!.getAttribute('data-peer-id'), 'peer2');

        assert.equal(env.gridWrapper.children.length, 0, 'Grid wrapper must be empty in spotlight mode');
        assert.equal(env.gridWrapper.classList.contains('hidden'), true);
        assert.equal(env.spotlightStage.classList.contains('hidden'), false);
      } finally {
        env.cleanup();
      }
    });

    it('4.2: should reparent cards between stage and tray without interrupting playback', () => {
      const env = createRoomTestEnvironment();
      try {
        const stream1 = makeStream('stream-1');
        const stream2 = makeStream('stream-2');

        stateStore.roomSlots = [
          { peerId: 'peer1', senderName: 'Alice', color: '#ff4444', isStreaming: true, isLocal: false, stream: stream1 as any },
          { peerId: 'peer2', senderName: 'Bob', color: '#44ff44', isStreaming: true, isLocal: false, stream: stream2 as any },
        ];
        stateStore.subscribedStreams.add('peer1');
        stateStore.subscribedStreams.add('peer2');

        stateStore.layoutMode = 'spotlight';
        stateStore.pinnedPeerId = 'peer1';
        env.renderer.renderRoomCards();

        const video1 = env.featuredArea.children[0]!.querySelector('video') as MockVideoElement;
        const video2 = env.trayStrip.children[0]!.querySelector('video') as MockVideoElement;
        assert.ok(video1 && video2);

        // Switch spotlight to Peer 2
        stateStore.pinnedPeerId = 'peer2';
        env.renderer.renderRoomCards();

        assert.equal(env.featuredArea.children[0]!.getAttribute('data-peer-id'), 'peer2');
        assert.equal(env.trayStrip.children[0]!.getAttribute('data-peer-id'), 'peer1');

        const video2After = env.featuredArea.children[0]!.querySelector('video') as MockVideoElement;
        const video1After = env.trayStrip.children[0]!.querySelector('video') as MockVideoElement;

        assert.strictEqual(video1, video1After, 'Peer 1 video preserved when moved to tray');
        assert.strictEqual(video2, video2After, 'Peer 2 video preserved when moved to stage');
        assert.equal(video1.paused, false, 'Peer 1 playback not interrupted');
        assert.equal(video2.paused, false, 'Peer 2 playback not interrupted');
      } finally {
        env.cleanup();
      }
    });

    it('4.3: should auto-revert layout to grid when pinned peer disconnects', () => {
      const env = createRoomTestEnvironment();
      try {
        const stream1 = makeStream('stream-1');
        stateStore.roomSlots = [
          { peerId: 'local', senderName: 'Me', color: '#00ccff', isStreaming: false, isLocal: true, stream: null },
          { peerId: 'peer1', senderName: 'Alice', color: '#ff4444', isStreaming: true, isLocal: false, stream: stream1 as any },
        ];
        stateStore.subscribedStreams.add('peer1');

        stateStore.layoutMode = 'spotlight';
        stateStore.pinnedPeerId = 'peer1';
        env.renderer.renderRoomCards();
        assert.equal(stateStore.layoutMode, 'spotlight');

        // Peer 1 departs
        stateStore.roomSlots = [stateStore.roomSlots[0]!];
        stateStore.subscribedStreams.delete('peer1');

        env.renderer.renderRoomCards();

        assert.equal(stateStore.pinnedPeerId, null, 'pinnedPeerId must be reset to null');
        assert.equal(stateStore.layoutMode, 'grid', 'layoutMode must automatically revert to grid');
        assert.equal(env.gridWrapper.classList.contains('hidden'), false);
        assert.equal(env.spotlightStage.classList.contains('hidden'), true);
        assert.equal(env.gridWrapper.children.length, 1);
      } finally {
        env.cleanup();
      }
    });
  });

  describe('Suite 5: Explicit GPU Decoder Surface & Audio Cleanup', () => {
    it('5.1: should explicitly cleanup video element (pause, srcObject=null, load) when stream stops', () => {
      const env = createRoomTestEnvironment();
      try {
        const stream1 = makeStream('stream-1');
        stateStore.roomSlots = [
          { peerId: 'peer1', senderName: 'Alice', color: '#ff4444', isStreaming: true, isLocal: false, stream: stream1 as any },
        ];
        stateStore.subscribedStreams.add('peer1');

        env.renderer.renderRoomCards();

        const initialCard = env.gridWrapper.children[0] as MockElement;
        const video = initialCard.querySelector('video') as MockVideoElement;
        assert.ok(video, 'Video element must exist while streaming');

        // Stream stops
        stateStore.roomSlots[0]!.isStreaming = false;
        stateStore.roomSlots[0]!.stream = null;

        env.renderer.renderRoomCards();

        // 4-step GPU release protocol verified
        assert.equal(video.paused, true, '1. video.pause() executed');
        assert.equal(video.srcObject, null, '2. video.srcObject = null executed');
        assert.ok(video.loadCount > 0, '3. video.load() executed to destroy hardware decoder surface');

        const updatedCard = env.gridWrapper.children[0] as MockElement;
        assert.ok(updatedCard.classList.contains('participant-card'), 'Card transitioned to participant-card');
        assert.equal(updatedCard.querySelector('video'), null, 'No video element in participant-card');
      } finally {
        env.cleanup();
      }
    });

    it('5.2: should explicitly cleanup video and audio when user clicks "Parar de Assistir"', () => {
      const env = createRoomTestEnvironment();
      try {
        const stream1 = makeStream('stream-1');
        stateStore.roomSlots = [
          { peerId: 'peer1', senderName: 'Alice', color: '#ff4444', isStreaming: true, isLocal: false, stream: stream1 as any },
        ];
        stateStore.subscribedStreams.add('peer1');

        let stopPeerNotified = '';
        env.callbacks.onStopWatchingStream = (id) => {
          stopPeerNotified = id;
        };

        env.renderer.renderRoomCards();

        const card = env.gridWrapper.children[0] as MockElement;
        const video = card.querySelector('video') as MockVideoElement;
        assert.ok(video);

        const stopBtn = card.querySelector('.btn-stop-watch-stream') as MockElement;
        assert.ok(stopBtn, 'Stop watching button must be present on subscribed stream card');

        // User clicks stop button
        stopBtn.click();

        assert.equal(stopPeerNotified, 'peer1', 'onStopWatchingStream callback invoked');
        assert.equal(stateStore.subscribedStreams.has('peer1'), false, 'Subscribed streams set pruned');

        // Video and decoder released
        assert.equal(video.paused, true);
        assert.equal(video.srcObject, null);
        assert.ok(video.loadCount > 0);

        const cardAfter = env.gridWrapper.children[0] as MockElement;
        assert.ok(cardAfter.classList.contains('participant-card'), 'Card transitioned to unsubscribed avatar card');
      } finally {
        env.cleanup();
      }
    });

    it('5.3: should completely dismantle all video elements and audio sinks on clear()', () => {
      const env = createRoomTestEnvironment();
      try {
        const stream1 = makeStream('stream-1');
        const stream2 = makeStream('stream-2');

        stateStore.roomSlots = [
          { peerId: 'peer1', senderName: 'Alice', color: '#ff4444', isStreaming: true, isLocal: false, stream: stream1 as any },
          { peerId: 'peer2', senderName: 'Bob', color: '#44ff44', isStreaming: true, isLocal: false, stream: stream2 as any },
        ];
        stateStore.subscribedStreams.add('peer1');
        stateStore.subscribedStreams.add('peer2');

        env.renderer.renderRoomCards();

        const video1 = env.gridWrapper.children[0]!.querySelector('video') as MockVideoElement;
        const video2 = env.gridWrapper.children[1]!.querySelector('video') as MockVideoElement;
        assert.ok(video1 && video2);

        // Clear renderer (e.g. room teardown / unmount)
        env.renderer.clear();

        assert.equal(video1.paused, true);
        assert.equal(video1.srcObject, null);
        assert.ok(video1.loadCount > 0);

        assert.equal(video2.paused, true);
        assert.equal(video2.srcObject, null);
        assert.ok(video2.loadCount > 0);

        assert.equal((env.renderer as any).cachedCards.size, 0, 'Cached cards map completely cleared');
        assert.equal(env.gridWrapper.children.length, 0, 'Grid wrapper emptied');
        assert.equal(env.featuredArea.children.length, 0, 'Featured area emptied');
        assert.equal(env.trayStrip.children.length, 0, 'Tray strip emptied');
      } finally {
        env.cleanup();
      }
    });
  });

  describe('Suite 6: AudioContextManager Shared Singleton & 10+ Stream Scaling', () => {
    it('6.1: should enforce singleton AudioContext across 15 concurrent remote streams', () => {
      const env = createRoomTestEnvironment();
      try {
        MockAudioContext.instanceCount = 0;

        for (let i = 1; i <= 15; i++) {
          const stream = makeStream(`peer-${i}-stream`, true);
          audioContextManager.attachPeerAudio(`peer-${i}`, stream as any);
        }

        assert.equal(
          MockAudioContext.instanceCount,
          1,
          'Must allocate exactly 1 AudioContext across 15 concurrent remote streams'
        );

        const sinks = (audioContextManager as any).peerSinks as Map<string, any>;
        assert.equal(sinks.size, 15, 'All 15 peers have active audio sink entries');
      } finally {
        env.cleanup();
      }
    });

    it('6.2: should maintain isolated volume and mute state per peer', () => {
      const env = createRoomTestEnvironment();
      try {
        const streamA = makeStream('stream-a', true);
        const streamB = makeStream('stream-b', true);

        audioContextManager.attachPeerAudio('peerA', streamA as any);
        audioContextManager.attachPeerAudio('peerB', streamB as any);

        audioContextManager.setPeerVolume('peerA', 35);
        audioContextManager.setPeerVolume('peerB', 85);

        assert.equal(audioContextManager.getPeerVolumeState('peerA').volume, 35);
        assert.equal(audioContextManager.getPeerVolumeState('peerB').volume, 85);

        // Mute peerA
        audioContextManager.setPeerVolume('peerA', 35, true);

        const stateA = audioContextManager.getPeerVolumeState('peerA');
        const stateB = audioContextManager.getPeerVolumeState('peerB');

        assert.equal(stateA.isMuted, true);
        assert.equal(stateB.isMuted, false);

        const sinks = (audioContextManager as any).peerSinks as Map<string, any>;
        assert.equal(sinks.get('peerA').gainNode.gain.value, 0, 'Muted peer gain is 0');
        assert.equal(sinks.get('peerB').gainNode.gain.value, 0.85, 'Sibling peer gain remains 0.85');
      } finally {
        env.cleanup();
      }
    });

    it('6.3: should detach individual peer audio without disturbing sibling streams', () => {
      const env = createRoomTestEnvironment();
      try {
        for (let i = 1; i <= 5; i++) {
          const stream = makeStream(`stream-${i}`, true);
          audioContextManager.attachPeerAudio(`peer-${i}`, stream as any);
        }

        const sinks = (audioContextManager as any).peerSinks as Map<string, any>;
        assert.equal(sinks.size, 5);

        // Detach peer 3
        audioContextManager.detachPeerAudio('peer-3');

        assert.equal(sinks.has('peer-3'), false, 'Peer 3 removed from sinks');
        assert.equal(sinks.size, 4, '4 sibling peers remain connected');
        assert.equal(sinks.has('peer-1'), true);
        assert.equal(sinks.has('peer-2'), true);
        assert.equal(sinks.has('peer-4'), true);
        assert.equal(sinks.has('peer-5'), true);
      } finally {
        env.cleanup();
      }
    });
  });

  describe('Suite 7: Boundary & Stress Resistance', () => {
    it('7.1: should handle empty room reconciliation (0 slots) without throwing', () => {
      const env = createRoomTestEnvironment();
      try {
        stateStore.roomSlots = [];
        env.renderer.renderRoomCards();

        assert.equal(env.gridWrapper.children.length, 0);
        assert.equal(env.featuredArea.children.length, 0);
        assert.equal(env.trayStrip.children.length, 0);
        assert.equal(env.sharingTag.textContent, '0 pessoas (0 ao vivo)');
      } finally {
        env.cleanup();
      }
    });

    it('7.2: should survive 100 rapid layout switches (grid <-> spotlight) with zero duplicate elements', () => {
      const env = createRoomTestEnvironment();
      try {
        const slots: RoomSlotInfo[] = [
          { peerId: 'local', senderName: 'Me', color: '#00ccff', isStreaming: false, isLocal: true, stream: null },
        ];
        for (let i = 1; i <= 4; i++) {
          const stream = makeStream(`stream-${i}`);
          slots.push({
            peerId: `peer-${i}`,
            senderName: `User ${i}`,
            color: '#ff4444',
            isStreaming: true,
            isLocal: false,
            stream: stream as any,
          });
          stateStore.subscribedStreams.add(`peer-${i}`);
        }
        stateStore.roomSlots = slots;

        // Perform 100 rapid switches
        for (let i = 0; i < 100; i++) {
          if (i % 2 === 0) {
            stateStore.layoutMode = 'spotlight';
            stateStore.pinnedPeerId = 'peer-1';
          } else {
            stateStore.layoutMode = 'grid';
            stateStore.pinnedPeerId = null;
          }
          env.renderer.renderRoomCards();
        }

        // Final state: grid mode
        stateStore.layoutMode = 'grid';
        stateStore.pinnedPeerId = null;
        env.renderer.renderRoomCards();

        const cachedCardsMap = (env.renderer as any).cachedCards as Map<string, any>;
        assert.equal(cachedCardsMap.size, 5, 'Exactly 5 cards cached across 100 toggles');
        assert.equal(env.gridWrapper.children.length, 5, 'Exactly 5 cards in grid');
        assert.equal(env.featuredArea.children.length, 0, 'Featured area clean');
        assert.equal(env.trayStrip.children.length, 0, 'Tray strip clean');
      } finally {
        env.cleanup();
      }
    });
  });
});
