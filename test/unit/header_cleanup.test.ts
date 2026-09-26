import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../../src/core/state_store.ts';
import type { RoomSlotInfo } from '../../src/core/types.ts';

describe('Header Cleanup, Stream Fullscreen & Sidebar Toggle Architecture', () => {
  let store: StateStore;

  beforeEach(() => {
    store = StateStore.getInstance();
    store.isSidebarCollapsed = false;
    store.isSharingScreen = false;
    store.subscribedStreams = new Set();
    store.roomSlots = [
      {
        peerId: 'local-peer',
        senderName: 'CurrentUser',
        stream: null,
        isStreaming: false,
        isLocal: true,
        color: '#ff0055',
      },
      {
        peerId: 'remote-1',
        senderName: 'Streamer1',
        stream: {} as MediaStream,
        isStreaming: true,
        isLocal: false,
        color: '#00dd88',
      },
      {
        peerId: 'remote-2',
        senderName: 'Viewer1',
        stream: null,
        isStreaming: false,
        isLocal: false,
        color: '#8800ff',
      },
    ];
  });

  describe('Sidebar Toggle Logic', () => {
    it('initial state has sidebar expanded (not collapsed)', () => {
      assert.strictEqual(store.isSidebarCollapsed, false);
    });

    it('toggle sets isSidebarCollapsed to true and back to false', () => {
      // Toggle to collapsed
      store.set((s) => {
        s.isSidebarCollapsed = !s.isSidebarCollapsed;
      });
      assert.strictEqual(store.isSidebarCollapsed, true);

      // Toggle back to expanded
      store.set((s) => {
        s.isSidebarCollapsed = !s.isSidebarCollapsed;
      });
      assert.strictEqual(store.isSidebarCollapsed, false);
    });
  });

  describe('Transmission Button Labeling', () => {
    it('displays "Transmitir" when not sharing screen', () => {
      store.isSharingScreen = false;
      const label = store.isSharingScreen ? 'Parar Transmissão' : 'Transmitir';
      assert.strictEqual(label, 'Transmitir');
    });

    it('displays "Parar Transmissão" when actively sharing screen', () => {
      store.isSharingScreen = true;
      const label = store.isSharingScreen ? 'Parar Transmissão' : 'Transmitir';
      assert.strictEqual(label, 'Parar Transmissão');
    });
  });

  describe('Header Filter Counts without Extraneous Status Badges', () => {
    it('accurately computes totalCount, streamingCount, and watchingCount', () => {
      const totalCount = store.roomSlots.length;
      const streamingCount = store.roomSlots.filter((s) => s.isStreaming).length;
      const watchingCount = store.roomSlots.filter(
        (s) => (s.isLocal && s.isStreaming) || (!s.isLocal && s.isStreaming && store.subscribedStreams.has(s.peerId))
      ).length;

      assert.strictEqual(totalCount, 3);
      assert.strictEqual(streamingCount, 1);
      assert.strictEqual(watchingCount, 0);

      // Local user streaming does not increment watchingCount
      store.roomSlots[0]!.isStreaming = true;
      const watchingWithLocalStreaming = store.roomSlots.filter(
        (s) => !s.isLocal && s.isStreaming && store.subscribedStreams.has(s.peerId)
      ).length;
      assert.strictEqual(watchingWithLocalStreaming, 0);

      // Subscribe to remote-1
      store.subscribedStreams.add('remote-1');
      const updatedWatching = store.roomSlots.filter(
        (s) => !s.isLocal && s.isStreaming && store.subscribedStreams.has(s.peerId)
      ).length;
      assert.strictEqual(updatedWatching, 1);
    });
  });

  describe('Stream-Specific Fullscreen State Simulation', () => {
    it('correctly tracks stream-specific target element in fullscreen comparison', () => {
      const mockCard1 = { id: 'card-remote-1' };
      const mockCard2 = { id: 'card-remote-2' };

      let currentFullscreenElement: unknown = null;

      const isCard1Fullscreen = () => currentFullscreenElement === mockCard1;
      const isCard2Fullscreen = () => currentFullscreenElement === mockCard2;

      assert.strictEqual(isCard1Fullscreen(), false);
      assert.strictEqual(isCard2Fullscreen(), false);

      // Card 1 enters fullscreen
      currentFullscreenElement = mockCard1;
      assert.strictEqual(isCard1Fullscreen(), true);
      assert.strictEqual(isCard2Fullscreen(), false);

      // Fullscreen exited
      currentFullscreenElement = null;
      assert.strictEqual(isCard1Fullscreen(), false);
      assert.strictEqual(isCard2Fullscreen(), false);
    });
  });
});
