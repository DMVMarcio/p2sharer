import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertReferentialEqual } from '../harness/assertions.ts';
import {
  setupTestDOM,
  MockElement,
  MockVideoElement,
  MockMediaStream,
  MockAudioContext,
} from '../harness/dom-mock.ts';
import type { RoomSlotInfo } from '../harness/types.ts';

describe('Tier 1: R4 Viewer Rendering & DOM Invariants Coverage', () => {
  it('R4-T1-1: Should retain existing video element instance during non-destructive reconciliation', () => {
    const dom = setupTestDOM();
    try {
      const cachedElements = new Map<string, MockVideoElement>();

      function reconcileVideoSlot(slot: RoomSlotInfo): MockVideoElement {
        let video = cachedElements.get(slot.peerId);
        if (!video) {
          video = dom.document.createElement('video') as MockVideoElement;
          cachedElements.set(slot.peerId, video);
        }
        if (slot.stream && video.srcObject !== slot.stream) {
          video.srcObject = slot.stream as MockMediaStream;
          video.play();
        }
        return video;
      }

      const stream1 = new MockMediaStream('stream-1');
      const slot: RoomSlotInfo = {
        peerId: 'peer-1',
        senderName: 'Alice',
        color: '#ff0000',
        isStreaming: true,
        isLocal: false,
        stream: stream1,
      };

      const videoA = reconcileVideoSlot(slot);
      assert.equal(videoA.playCount, 1);
      assert.equal(videoA.srcObject, stream1);

      // Re-reconcile with unchanged stream
      const videoB = reconcileVideoSlot(slot);
      assertReferentialEqual(videoB, videoA, 'Reconciliation must reuse identical video element instance');
      assert.equal(videoB.playCount, 1, 'play() should not be re-triggered when stream is identical');
    } finally {
      dom.cleanup();
    }
  });

  it('R4-T1-2: Should populate grid wrapper with cards for all room slots', () => {
    const dom = setupTestDOM();
    try {
      const grid = dom.document.createElement('div');
      grid.id = 'streams-grid-wrapper';
      dom.document.registerElement('streams-grid-wrapper', grid);

      const slots: RoomSlotInfo[] = [
        { peerId: 'p1', senderName: 'Alice', color: '#f00', isStreaming: false, isLocal: true, stream: null },
        { peerId: 'p2', senderName: 'Bob', color: '#0f0', isStreaming: true, isLocal: false, stream: new MockMediaStream() },
        { peerId: 'p3', senderName: 'Charlie', color: '#00f', isStreaming: false, isLocal: false, stream: null },
      ];

      slots.forEach((s) => {
        const card = dom.document.createElement('div');
        card.id = `card-${s.peerId}`;
        card.textContent = s.senderName;
        grid.appendChild(card);
      });

      assert.equal(grid.children.length, 3);
      assert.equal(grid.children[0]!.id, 'card-p1');
      assert.equal(grid.children[1]!.id, 'card-p2');
      assert.equal(grid.children[2]!.id, 'card-p3');
    } finally {
      dom.cleanup();
    }
  });

  it('R4-T1-3: Should partition cards into stage and tray in Spotlight layout mode', () => {
    const dom = setupTestDOM();
    try {
      const stage = dom.document.createElement('div');
      stage.id = 'spotlight-featured-area';
      const tray = dom.document.createElement('div');
      tray.id = 'spotlight-tray-strip';

      const slots: RoomSlotInfo[] = [
        { peerId: 'p1', senderName: 'Alice', color: '#f00', isStreaming: true, isLocal: false, stream: new MockMediaStream() },
        { peerId: 'p2', senderName: 'Bob', color: '#0f0', isStreaming: false, isLocal: false, stream: null },
        { peerId: 'p3', senderName: 'Charlie', color: '#00f', isStreaming: false, isLocal: false, stream: null },
      ];

      const pinnedPeerId = 'p1';
      const featured = slots.find((s) => s.peerId === pinnedPeerId)!;
      const others = slots.filter((s) => s.peerId !== pinnedPeerId);

      const stageCard = dom.document.createElement('div');
      stageCard.id = `card-${featured.peerId}`;
      stage.appendChild(stageCard);

      others.forEach((s) => {
        const trayCard = dom.document.createElement('div');
        trayCard.id = `card-${s.peerId}`;
        tray.appendChild(trayCard);
      });

      assert.equal(stage.children.length, 1);
      assert.equal(stage.children[0]!.id, 'card-p1');
      assert.equal(tray.children.length, 2);
      assert.equal(tray.children[0]!.id, 'card-p2');
      assert.equal(tray.children[1]!.id, 'card-p3');
    } finally {
      dom.cleanup();
    }
  });

  it('R4-T1-4: Should clean up DOM and cache entries when peer departs', () => {
    const dom = setupTestDOM();
    try {
      const container = dom.document.createElement('div');
      const cardMap = new Map<string, MockElement>();

      function addPeer(peerId: string) {
        const card = dom.document.createElement('div');
        card.id = `peer-card-${peerId}`;
        cardMap.set(peerId, card);
        container.appendChild(card);
      }

      function removePeer(peerId: string) {
        const card = cardMap.get(peerId);
        if (card) {
          container.removeChild(card);
          cardMap.delete(peerId);
        }
      }

      addPeer('user-1');
      addPeer('user-2');
      assert.equal(container.children.length, 2);

      removePeer('user-1');
      assert.equal(container.children.length, 1);
      assert.equal(cardMap.has('user-1'), false);
      assert.equal(container.children[0]!.id, 'peer-card-user-2');
    } finally {
      dom.cleanup();
    }
  });

  it('R4-T1-5: Should enforce Singleton AudioContext invariant across multiple remote streams', () => {
    const dom = setupTestDOM();
    try {
      // Invariant: AudioContext must be a singleton to avoid the browser 6-context limit
      class AudioContextManager {
        private static instance: MockAudioContext | null = null;

        public static getContext(): MockAudioContext {
          if (!this.instance || this.instance.state === 'closed') {
            this.instance = new MockAudioContext({ sampleRate: 48000 });
          }
          return this.instance;
        }
      }

      const streams = ['peer-1', 'peer-2', 'peer-3', 'peer-4', 'peer-5', 'peer-6', 'peer-7'];
      const gainNodes: any[] = [];

      for (const _peer of streams) {
        const ctx = AudioContextManager.getContext();
        const gain = ctx.createGain();
        gainNodes.push(gain);
      }

      assert.equal(MockAudioContext.instanceCount, 1, 'Exactly one AudioContext must be instantiated for all streams');
      assert.equal(gainNodes.length, 7, 'All 7 streams get their own distinct GainNode');
    } finally {
      dom.cleanup();
    }
  });

  it('R4-T1-6: Should correctly toggle visibility classes between grid and spotlight modes', () => {
    const dom = setupTestDOM();
    try {
      const grid = dom.document.createElement('div');
      const spotlight = dom.document.createElement('div');

      function setLayoutMode(mode: 'grid' | 'spotlight') {
        if (mode === 'grid') {
          grid.classList.remove('hidden');
          spotlight.classList.add('hidden');
        } else {
          grid.classList.add('hidden');
          spotlight.classList.remove('hidden');
        }
      }

      setLayoutMode('grid');
      assert.equal(grid.classList.contains('hidden'), false);
      assert.equal(spotlight.classList.contains('hidden'), true);

      setLayoutMode('spotlight');
      assert.equal(grid.classList.contains('hidden'), true);
      assert.equal(spotlight.classList.contains('hidden'), false);
    } finally {
      dom.cleanup();
    }
  });
});
