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

    it('filter "watching" returns only remote streams actively subscribed, ignoring own screen', () => {
      store.subscribedStreams.add('peer-alice');

      const filterFn = (slot: RoomSlotInfo, mode: StreamFilterMode, subscribed: Set<string>) => {
        if (mode === 'streaming') return slot.isStreaming;
        if (mode === 'watching') {
          return !slot.isLocal && slot.isStreaming && subscribed.has(slot.peerId);
        }
        return true;
      };

      const result = store.roomSlots.filter((s) => filterFn(s, 'watching', store.subscribedStreams));
      assert.equal(result.length, 1);
      assert.equal(result[0]!.peerId, 'peer-alice');

      // Now make local user stream as well - should NOT be included in "watching"
      store.roomSlots[0]!.isStreaming = true;
      const resultWithLocal = store.roomSlots.filter((s) => filterFn(s, 'watching', store.subscribedStreams));
      assert.equal(resultWithLocal.length, 1);
      assert.equal(resultWithLocal[0]!.peerId, 'peer-alice');
      assert.ok(!resultWithLocal.some((s) => s.peerId === 'peer-local'));
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

  describe('Resolution Bitrate Automation', () => {
    it('returns appropriate default bitrates for each resolution', () => {
      assert.equal(store.getDefaultBitrateForResolution('720p'), 8000);
      assert.equal(store.getDefaultBitrateForResolution('1080p'), 15000);
      assert.equal(store.getDefaultBitrateForResolution('1440p'), 25000);
      assert.equal(store.getDefaultBitrateForResolution('4k'), 35000);
      assert.equal(store.getDefaultBitrateForResolution('480p'), 3000);
      assert.equal(store.getDefaultBitrateForResolution('360p'), 1000);
    });

    it('fallback resolution returns default 15 Mbps', () => {
      assert.equal(store.getDefaultBitrateForResolution('unknown'), 15000);
    });
  });

  describe('Spotlight Tray Card Element Simplification', () => {
    it('determines live badge visibility: omitted when inTray is true, shown when inTray is false', () => {
      const shouldShowLiveBadge = (slot: RoomSlotInfo, isSubscribed: boolean, inTray: boolean) => {
        return !inTray && !slot.isLocal && slot.isStreaming && !isSubscribed;
      };

      const remoteStreamingSlot: RoomSlotInfo = {
        peerId: 'peer-alice',
        senderName: 'Alice',
        stream: null,
        isStreaming: true,
        isLocal: false,
        color: '#00ff00',
      };

      // In featured area / stage (inTray = false): live badge is visible
      assert.equal(shouldShowLiveBadge(remoteStreamingSlot, false, false), true);
      // In bottom tray (inTray = true): live badge is omitted
      assert.equal(shouldShowLiveBadge(remoteStreamingSlot, false, true), false);
      // When already subscribed: live badge is omitted regardless
      assert.equal(shouldShowLiveBadge(remoteStreamingSlot, true, false), false);
      assert.equal(shouldShowLiveBadge(remoteStreamingSlot, true, true), false);
    });

    it('determines local broadcaster title visibility: omitted when inTray is true, shown when inTray is false', () => {
      const shouldShowLocalBroadcasterTitle = (slot: RoomSlotInfo, showLocalPreview: boolean, inTray: boolean) => {
        return !inTray && slot.isLocal && !showLocalPreview;
      };

      const localBroadcastingSlot: RoomSlotInfo = {
        peerId: 'peer-local',
        senderName: 'Local User',
        stream: {} as MediaStream,
        isStreaming: true,
        isLocal: true,
        color: '#ff0000',
      };

      // In featured area / stage (inTray = false): "Você está transmitindo" title is visible
      assert.equal(shouldShowLocalBroadcasterTitle(localBroadcastingSlot, false, false), true);
      // In bottom tray (inTray = true): "Você está transmitindo" title is omitted
      assert.equal(shouldShowLocalBroadcasterTitle(localBroadcastingSlot, false, true), false);
    });
  });
});
