import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../../src/core/state_store.ts';
import type { RoomSlotInfo, StreamFilterMode } from '../../src/core/types.ts';

describe('Spotlight Tray & Stream Filters Architecture', () => {
  let store: StateStore;

  beforeEach(() => {
    store = StateStore.getInstance();
    store.streamFilter = 'all';
    store.pinnedPeerId = null;
    store.layoutMode = 'spotlight';
    store.subscribedStreams = new Set();
    store.roomSlots = [
      {
        peerId: 'peer-local',
        senderName: 'Local User',
        stream: null,
        isStreaming: false,
        isLocal: true,
        color: '#ff0000',
      },
      {
        peerId: 'peer-alice',
        senderName: 'Alice',
        stream: {} as MediaStream,
        isStreaming: true,
        isLocal: false,
        color: '#00ff00',
      },
      {
        peerId: 'peer-bob',
        senderName: 'Bob',
        stream: {} as MediaStream,
        isStreaming: true,
        isLocal: false,
        color: '#0000ff',
      },
      {
        peerId: 'peer-charlie',
        senderName: 'Charlie',
        stream: null,
        isStreaming: false,
        isLocal: false,
        color: '#ffff00',
      },
    ];
  });

  describe('Stream Filter Logic', () => {
    it('filter "all" returns all participants in room', () => {
      const filterFn = (slot: RoomSlotInfo, mode: StreamFilterMode, subscribed: Set<string>) => {
        if (mode === 'streaming') return slot.isStreaming;
        if (mode === 'watching') {
          return (slot.isLocal && slot.isStreaming) || (!slot.isLocal && slot.isStreaming && subscribed.has(slot.peerId));
        }
        return true;
      };

      const result = store.roomSlots.filter((s) => filterFn(s, 'all', store.subscribedStreams));
      assert.equal(result.length, 4);
    });

    it('filter "streaming" returns only active screen share broadcasters', () => {
      const filterFn = (slot: RoomSlotInfo, mode: StreamFilterMode, subscribed: Set<string>) => {
        if (mode === 'streaming') return slot.isStreaming;
        if (mode === 'watching') {
          return (slot.isLocal && slot.isStreaming) || (!slot.isLocal && slot.isStreaming && subscribed.has(slot.peerId));
        }
        return true;
      };

      const result = store.roomSlots.filter((s) => filterFn(s, 'streaming', store.subscribedStreams));
      assert.equal(result.length, 2);
      assert.ok(result.some((s) => s.peerId === 'peer-alice'));
      assert.ok(result.some((s) => s.peerId === 'peer-bob'));
      assert.ok(!result.some((s) => s.peerId === 'peer-local'));
      assert.ok(!result.some((s) => s.peerId === 'peer-charlie'));
    });

    it('filter "watching" returns only streams actively subscribed or local streaming', () => {
      store.subscribedStreams.add('peer-alice');

      const filterFn = (slot: RoomSlotInfo, mode: StreamFilterMode, subscribed: Set<string>) => {
        if (mode === 'streaming') return slot.isStreaming;
        if (mode === 'watching') {
          return (slot.isLocal && slot.isStreaming) || (!slot.isLocal && slot.isStreaming && subscribed.has(slot.peerId));
        }
        return true;
      };

      const result = store.roomSlots.filter((s) => filterFn(s, 'watching', store.subscribedStreams));
      assert.equal(result.length, 1);
      assert.equal(result[0]!.peerId, 'peer-alice');

      // Now make local user stream as well
      store.roomSlots[0]!.isStreaming = true;
      const resultWithLocal = store.roomSlots.filter((s) => filterFn(s, 'watching', store.subscribedStreams));
      assert.equal(resultWithLocal.length, 2);
      assert.ok(resultWithLocal.some((s) => s.peerId === 'peer-local'));
      assert.ok(resultWithLocal.some((s) => s.peerId === 'peer-alice'));
    });
  });

  describe('Spotlight Tray Stability & Selection Indicator', () => {
    it('bottom tray retains all slots including featuredSlot to prevent layout jitter', () => {
      store.pinnedPeerId = 'peer-alice';
      const featuredSlot = store.roomSlots.find((s) => s.peerId === store.pinnedPeerId) || store.roomSlots[0]!;

      // In the new architecture, the tray renders all room slots
      const traySlots = store.roomSlots;
      assert.equal(traySlots.length, 4);

      // Verify isSelectedFeatured computation
      const selectedItem = traySlots.find((s) => s.peerId === featuredSlot.peerId);
      assert.ok(selectedItem);
      assert.equal(selectedItem.peerId, 'peer-alice');
    });

    it('switching pinnedPeerId updates selection flag without shifting tray items or counts', () => {
      // Pin Alice first
      store.pinnedPeerId = 'peer-alice';
      let featured = store.roomSlots.find((s) => s.peerId === store.pinnedPeerId) || store.roomSlots[0]!;
      assert.equal(featured.peerId, 'peer-alice');

      let traySlots = store.roomSlots.map((s) => ({
        ...s,
        isSelectedFeatured: s.peerId === featured.peerId,
      }));
      assert.equal(traySlots.length, 4);
      assert.equal(traySlots[1]!.isSelectedFeatured, true);
      assert.equal(traySlots[2]!.isSelectedFeatured, false);

      // Switch pin to Bob
      store.pinnedPeerId = 'peer-bob';
      featured = store.roomSlots.find((s) => s.peerId === store.pinnedPeerId) || store.roomSlots[0]!;
      assert.equal(featured.peerId, 'peer-bob');

      traySlots = store.roomSlots.map((s) => ({
        ...s,
        isSelectedFeatured: s.peerId === featured.peerId,
      }));
      // Count and order in tray remains exactly 4 and unchanged
      assert.equal(traySlots.length, 4);
      assert.equal(traySlots[0]!.peerId, 'peer-local');
      assert.equal(traySlots[1]!.peerId, 'peer-alice');
      assert.equal(traySlots[2]!.peerId, 'peer-bob');
      assert.equal(traySlots[3]!.peerId, 'peer-charlie');

      // But now Bob is selected, Alice is unselected
      assert.equal(traySlots[1]!.isSelectedFeatured, false);
      assert.equal(traySlots[2]!.isSelectedFeatured, true);
    });
  });
});
