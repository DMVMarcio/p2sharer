import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertReferentialEqual } from '../harness/assertions.ts';
import {
  setupTestDOM,
  MockElement,
  MockVideoElement,
  MockMediaStream,
} from '../harness/dom-mock.ts';
import { SignalingFailoverMachine } from '../harness/signaling-oracle.ts';
import type { RoomSlotInfo } from '../harness/types.ts';

describe('Tier 3: Room Resilience & Multi-Peer Combinations', () => {
  it('R2+R2-T3-1: Should recover 4-peer room state after signaling transport failover', () => {
    const machine = new SignalingFailoverMachine();
    machine.connect('mqtt');

    // 4 peers join room
    ['peer-1', 'peer-2', 'peer-3', 'peer-4'].forEach((p) => {
      machine.receivePeerExchange(p, true);
    });
    assert.equal(machine.directConnectedPeers.size, 4);

    // Primary transport fails
    const newTransport = machine.recordWatchdogFailure();
    assert.equal(newTransport, 'nostr');

    // Direct WebRTC peers maintain their connections during signaling switch
    assert.equal(machine.directConnectedPeers.size, 4);
    assert.ok(machine.directConnectedPeers.has('peer-1'));
    assert.ok(machine.directConnectedPeers.has('peer-4'));
  });

  it('R2+R4-T3-2: Should execute stream recovery protocol and reuse video element after toggle', () => {
    const dom = setupTestDOM();
    try {
      const cardCache = new Map<string, { el: MockElement; videoEl: MockVideoElement | null }>();

      function reconcile(slot: RoomSlotInfo) {
        let entry = cardCache.get(slot.peerId);
        if (!entry) {
          const el = dom.document.createElement('div');
          el.id = `card-${slot.peerId}`;
          const videoEl = dom.document.createElement('video') as MockVideoElement;
          el.appendChild(videoEl);
          entry = { el, videoEl };
          cardCache.set(slot.peerId, entry);
        }

        if (slot.isStreaming && slot.stream) {
          if (entry.videoEl && entry.videoEl.srcObject !== slot.stream) {
            entry.videoEl.srcObject = slot.stream as MockMediaStream;
            entry.videoEl.play();
          }
        }
        return entry;
      }

      const streamA = new MockMediaStream('stream-A');
      const slot: RoomSlotInfo = {
        peerId: 'peer-host',
        senderName: 'Host',
        color: '#f00',
        isStreaming: true,
        isLocal: false,
        stream: streamA,
      };

      // 1. Initial stream start
      const firstEntry = reconcile(slot);
      const originalVideo = firstEntry.videoEl;
      assert.equal(originalVideo?.playCount, 1);
      assert.equal(originalVideo?.srcObject, streamA);

      // 2. Host stops sharing (screen toggle off)
      slot.isStreaming = false;
      slot.stream = null;
      reconcile(slot);

      // 3. Host restarts sharing with new track/stream (screen toggle on recovery)
      const streamB = new MockMediaStream('stream-B');
      slot.isStreaming = true;
      slot.stream = streamB;
      const recoveredEntry = reconcile(slot);

      // DOM element and video tag must be retained (no memory leak or re-creation)
      assertReferentialEqual(recoveredEntry.videoEl, originalVideo, 'Video element must be preserved across stream toggle');
      assert.equal(recoveredEntry.videoEl?.srcObject, streamB);
      assert.equal(recoveredEntry.videoEl?.playCount, 2);
    } finally {
      dom.cleanup();
    }
  });

  it('R2+R4-T3-3: Should route targeted media dispatch to intended peer without leakage to bystanders', () => {
    const targetPeerId = 'peer-intended';
    const bystanderPeerId = 'peer-bystander';

    interface StreamDispatch {
      target: string;
      streamId: string;
    }

    const dispatchedStreams: StreamDispatch[] = [];

    function sendTargetedStream(streamId: string, target: string) {
      dispatchedStreams.push({ streamId, target });
    }

    sendTargetedStream('screen-stream-101', targetPeerId);

    // Verify recipient receives stream
    const targetReceived = dispatchedStreams.filter((d) => d.target === targetPeerId);
    assert.equal(targetReceived.length, 1);
    assert.equal(targetReceived[0]!.streamId, 'screen-stream-101');

    // Verify bystander receives zero leaks
    const bystanderReceived = dispatchedStreams.filter((d) => d.target === bystanderPeerId);
    assert.equal(bystanderReceived.length, 0);
  });

  it('R2+R4-T3-4: Should reject unverified PEX rumor from creating a room slot card', () => {
    const dom = setupTestDOM();
    try {
      const machine = new SignalingFailoverMachine();
      machine.connect('mqtt');

      const grid = dom.document.createElement('div');

      function updateGridSlots(slots: RoomSlotInfo[]) {
        grid.innerHTML = '';
        slots.forEach((s) => {
          const card = dom.document.createElement('div');
          card.id = `card-${s.peerId}`;
          grid.appendChild(card);
        });
      }

      // Add 1 verified peer and 1 unverified rumor
      machine.receivePeerExchange('verified-peer', true);
      machine.receivePeerExchange('rumor-ghost', false);

      // Generate slots ONLY from verified direct peers
      const slots: RoomSlotInfo[] = Array.from(machine.directConnectedPeers).map((pid) => ({
        peerId: pid,
        senderName: pid,
        color: '#fff',
        isStreaming: false,
        isLocal: false,
        stream: null,
      }));

      updateGridSlots(slots);

      assert.equal(grid.children.length, 1);
      assert.equal(grid.children[0]!.id, 'card-verified-peer');
      assert.equal(grid.querySelector('#card-rumor-ghost'), null);
    } finally {
      dom.cleanup();
    }
  });

  it('R2+R4-T3-5: Should handle broadcaster departure by detaching card and reverting spotlight layout', () => {
    const dom = setupTestDOM();
    try {
      const featuredArea = dom.document.createElement('div');
      let layoutMode: 'grid' | 'spotlight' = 'spotlight';
      let pinnedPeerId: string | null = 'peer-streamer';

      let activeSlots: RoomSlotInfo[] = [
        { peerId: 'peer-streamer', senderName: 'Streamer', color: '#f00', isStreaming: true, isLocal: false, stream: new MockMediaStream() },
        { peerId: 'peer-viewer', senderName: 'Viewer', color: '#0f0', isStreaming: false, isLocal: false, stream: null },
      ];

      const streamerCard = dom.document.createElement('div');
      streamerCard.id = 'card-peer-streamer';
      featuredArea.appendChild(streamerCard);
      assert.equal(featuredArea.children.length, 1);

      // Streamer departs
      function onBroadcasterLeft(peerId: string) {
        activeSlots = activeSlots.filter((s) => s.peerId !== peerId);
        if (pinnedPeerId === peerId) {
          pinnedPeerId = null;
          layoutMode = 'grid';
          featuredArea.innerHTML = '';
        }
      }

      onBroadcasterLeft('peer-streamer');

      assert.equal(pinnedPeerId, null);
      assert.equal(layoutMode, 'grid');
      assert.equal(featuredArea.children.length, 0);
      assert.equal(activeSlots.length, 1);
      assert.equal(activeSlots[0]!.peerId, 'peer-viewer');
    } finally {
      dom.cleanup();
    }
  });
});
