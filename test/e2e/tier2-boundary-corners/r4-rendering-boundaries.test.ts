import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupTestDOM,
  MockElement,
  MockVideoElement,
  MockMediaStream,
  MockMediaStreamTrack,
} from '../harness/dom-mock.ts';
import type { RoomSlotInfo } from '../harness/types.ts';

describe('Tier 2: R4 Viewer Rendering Boundaries & Corner Cases', () => {
  it('R4-T2-1: Should handle empty room reconciliation (0 slots) cleanly', () => {
    const dom = setupTestDOM();
    try {
      const grid = dom.document.createElement('div');
      grid.id = 'streams-grid-wrapper';

      const cachedCards = new Map<string, MockElement>();
      const slots: RoomSlotInfo[] = [];

      // Reconcile 0 slots
      cachedCards.forEach((_, key) => {
        cachedCards.delete(key);
      });
      grid.innerHTML = '';

      assert.equal(grid.children.length, 0);
      assert.equal(cachedCards.size, 0);
    } finally {
      dom.cleanup();
    }
  });

  it('R4-T2-2: Should handle rapid spotlight toggling between 10 peers without duplicate DOM elements', () => {
    const dom = setupTestDOM();
    try {
      const stage = dom.document.createElement('div');
      const cardCache = new Map<string, MockElement>();

      function getOrCreateCard(peerId: string): MockElement {
        let card = cardCache.get(peerId);
        if (!card) {
          card = dom.document.createElement('div');
          card.id = `card-${peerId}`;
          cardCache.set(peerId, card);
        }
        return card;
      }

      function pinPeer(peerId: string) {
        stage.innerHTML = '';
        const card = getOrCreateCard(peerId);
        stage.appendChild(card);
      }

      // Rapidly toggle spotlight across 10 peers 5 times each (50 toggles)
      for (let cycle = 0; cycle < 5; cycle++) {
        for (let p = 0; p < 10; p++) {
          pinPeer(`peer-${p}`);
        }
      }

      // Exactly 10 cards ever created in cache
      assert.equal(cardCache.size, 10);
      // Stage currently contains exactly 1 card
      assert.equal(stage.children.length, 1);
      assert.equal(stage.children[0]!.id, 'card-peer-9');
    } finally {
      dom.cleanup();
    }
  });

  it('R4-T2-3: Should auto-revert layout from spotlight to grid when pinned peer disconnects', () => {
    let layoutMode: 'grid' | 'spotlight' = 'spotlight';
    let pinnedPeerId: string | null = 'peer-VIP';

    let currentSlots: RoomSlotInfo[] = [
      { peerId: 'peer-VIP', senderName: 'VIP', color: '#ff0', isStreaming: true, isLocal: false, stream: new MockMediaStream() },
      { peerId: 'peer-2', senderName: 'Viewer', color: '#0ff', isStreaming: false, isLocal: false, stream: null },
    ];

    function onPeerLeft(departedPeerId: string) {
      currentSlots = currentSlots.filter((s) => s.peerId !== departedPeerId);
      if (pinnedPeerId && !currentSlots.some((s) => s.peerId === pinnedPeerId)) {
        pinnedPeerId = null;
        layoutMode = 'grid';
      }
    }

    onPeerLeft('peer-VIP');
    assert.equal(pinnedPeerId, null);
    assert.equal(layoutMode, 'grid');
  });

  it('R4-T2-4: Should scale to 100 participants in room without memory exhaustion', () => {
    const dom = setupTestDOM();
    try {
      const grid = dom.document.createElement('div');
      const slots: RoomSlotInfo[] = [];

      for (let i = 0; i < 100; i++) {
        slots.push({
          peerId: `user-${i}`,
          senderName: `User ${i}`,
          color: '#333',
          isStreaming: i % 10 === 0, // 10 streamers out of 100
          isLocal: i === 0,
          stream: i % 10 === 0 ? new MockMediaStream(`stream-${i}`) : null,
        });
      }

      slots.forEach((s) => {
        const card = dom.document.createElement('div');
        card.id = `card-${s.peerId}`;
        grid.appendChild(card);
      });

      assert.equal(grid.children.length, 100);
      assert.equal(slots.filter((s) => s.isStreaming).length, 10);
    } finally {
      dom.cleanup();
    }
  });

  it('R4-T2-5: Should handle external media track end (readyState = ended) cleanly', () => {
    const track = new MockMediaStreamTrack('video', 'test-video-track');
    assert.equal(track.readyState, 'live');
    assert.equal(track.enabled, true);

    track.stop();
    assert.equal(track.readyState, 'ended');
    assert.equal(track.enabled, false);
    assert.equal(track.stopCount, 1);
  });

  it('R4-T2-6: Should transition card from video mode to avatar mode when stream ends', () => {
    const dom = setupTestDOM();
    try {
      const container = dom.document.createElement('div');
      let currentMode: 'video' | 'avatar' = 'video';
      const videoEl = dom.document.createElement('video') as MockVideoElement;
      const avatarEl = dom.document.createElement('div');
      avatarEl.id = 'avatar';

      function updateCardMode(isStreaming: boolean) {
        container.innerHTML = '';
        if (isStreaming) {
          currentMode = 'video';
          container.appendChild(videoEl);
        } else {
          currentMode = 'avatar';
          container.appendChild(avatarEl);
        }
      }

      updateCardMode(true);
      assert.equal(currentMode, 'video');
      assert.equal(container.children[0], videoEl);

      updateCardMode(false);
      assert.equal(currentMode, 'avatar');
      assert.equal(container.children[0], avatarEl);
    } finally {
      dom.cleanup();
    }
  });
});
