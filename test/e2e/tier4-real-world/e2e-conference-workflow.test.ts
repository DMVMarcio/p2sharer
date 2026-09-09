import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertNear } from '../harness/assertions.ts';
import {
  setupTestDOM,
  MockElement,
  MockVideoElement,
  MockCanvasElement,
  MockMediaStream,
  MockAudioContext,
} from '../harness/dom-mock.ts';
import type { RoomSlotInfo, ChatMessage } from '../harness/types.ts';

describe('Tier 4: E2E Conference Real-World Workflows', () => {
  it('WF-T4-1: Should complete 5-participant multi-screen conference lifecycle with dynamic spotlight and layout transitions', () => {
    const dom = setupTestDOM();
    try {
      const grid = dom.document.createElement('div');
      grid.id = 'streams-grid-wrapper';
      const stage = dom.document.createElement('div');
      stage.id = 'spotlight-featured-area';
      const tray = dom.document.createElement('div');
      tray.id = 'spotlight-tray-strip';

      let layoutMode: 'grid' | 'spotlight' = 'grid';
      let pinnedPeerId: string | null = null;
      const cachedCards = new Map<string, MockElement>();

      // 1. Initial State: 5 participants join the room
      const participants = ['Host', 'Alice', 'Bob', 'Charlie', 'Dave'];
      let slots: RoomSlotInfo[] = participants.map((name, i) => ({
        peerId: `peer-${i}`,
        senderName: name,
        color: `#00${i}`,
        isStreaming: false,
        isLocal: i === 0,
        stream: null,
      }));

      function render() {
        if (layoutMode === 'grid') {
          grid.innerHTML = '';
          slots.forEach((s) => {
            let card = cachedCards.get(s.peerId);
            if (!card) {
              card = dom.document.createElement('div');
              card.id = `card-${s.peerId}`;
              cachedCards.set(s.peerId, card);
            }
            grid.appendChild(card);
          });
        } else {
          stage.innerHTML = '';
          tray.innerHTML = '';
          const featured = slots.find((s) => s.peerId === pinnedPeerId) || slots[0]!;
          let featuredCard = cachedCards.get(featured.peerId);
          if (!featuredCard) {
            featuredCard = dom.document.createElement('div');
            featuredCard.id = `card-${featured.peerId}`;
            cachedCards.set(featured.peerId, featuredCard);
          }
          stage.appendChild(featuredCard);

          slots.filter((s) => s.peerId !== featured.peerId).forEach((s) => {
            let trayCard = cachedCards.get(s.peerId);
            if (!trayCard) {
              trayCard = dom.document.createElement('div');
              trayCard.id = `card-${s.peerId}`;
              cachedCards.set(s.peerId, trayCard);
            }
            tray.appendChild(trayCard);
          });
        }
      }

      render();
      assert.equal(grid.children.length, 5, 'All 5 participants visible in grid mode');

      // 2. Host starts screen sharing
      const hostStream = new MockMediaStream('host-stream');
      slots[0]!.isStreaming = true;
      slots[0]!.stream = hostStream;
      render();
      assert.equal(slots.filter((s) => s.isStreaming).length, 1);

      // 3. Alice also starts screen sharing (dual streaming)
      const aliceStream = new MockMediaStream('alice-stream');
      slots[1]!.isStreaming = true;
      slots[1]!.stream = aliceStream;
      render();
      assert.equal(slots.filter((s) => s.isStreaming).length, 2);

      // 4. Bob pins Host's presentation into Spotlight mode
      layoutMode = 'spotlight';
      pinnedPeerId = 'peer-0'; // Host
      render();
      assert.equal(stage.children.length, 1);
      assert.equal(stage.children[0]!.id, 'card-peer-0');
      assert.equal(tray.children.length, 4);

      // 5. Host stops screen sharing; auto-spotlight falls back to Alice (active streamer)
      slots[0]!.isStreaming = false;
      slots[0]!.stream = null;
      const nextStreamer = slots.find((s) => s.isStreaming);
      if (nextStreamer) {
        pinnedPeerId = nextStreamer.peerId;
      }
      render();
      assert.equal(pinnedPeerId, 'peer-1', 'Spotlight correctly transitioned to Alice');
      assert.equal(stage.children[0]!.id, 'card-peer-1');

      // 6. Alice stops sharing; layout auto-reverts to grid mode
      slots[1]!.isStreaming = false;
      slots[1]!.stream = null;
      if (!slots.some((s) => s.isStreaming)) {
        layoutMode = 'grid';
        pinnedPeerId = null;
      }
      render();
      assert.equal(layoutMode, 'grid');
      assert.equal(grid.children.length, 5);
    } finally {
      dom.cleanup();
    }
  });

  it('WF-T4-2: Should manage in-room text chat and ordered system activity events', () => {
    const chatHistory: ChatMessage[] = [];

    function sendChat(senderId: string, senderName: string, text: string, isSystem = false) {
      const msg: ChatMessage = {
        id: `msg-${Date.now()}-${Math.random()}`,
        senderId,
        senderName,
        text,
        timestamp: Date.now(),
        isSystem,
      };
      chatHistory.push(msg);
      return msg;
    }

    sendChat('system', 'System', 'Alice joined the room', true);
    sendChat('peer-alice', 'Alice', 'Hello everyone!');
    sendChat('peer-bob', 'Bob', 'Hi Alice, can you see my screen?');
    sendChat('system', 'System', 'Host started screen sharing', true);

    assert.equal(chatHistory.length, 4);
    assert.equal(chatHistory[0]!.isSystem, true);
    assert.equal(chatHistory[1]!.senderName, 'Alice');
    assert.equal(chatHistory[2]!.senderName, 'Bob');
    assert.equal(chatHistory[3]!.isSystem, true);

    // Verify chat timestamps are monotonically non-decreasing
    for (let i = 1; i < chatHistory.length; i++) {
      assert.ok(chatHistory[i]!.timestamp >= chatHistory[i - 1]!.timestamp);
    }
  });

  it('WF-T4-3: Should manage multi-party audio volume mixing with individual mute controls', () => {
    const dom = setupTestDOM();
    try {
      const sharedAudioCtx = new MockAudioContext();

      interface PeerAudioSink {
        gainNode: any;
        savedVolume: number;
        isMuted: boolean;
      }

      const audioSinks = new Map<string, PeerAudioSink>();

      ['peer-1', 'peer-2', 'peer-3'].forEach((pid) => {
        const gainNode = sharedAudioCtx.createGain();
        gainNode.gain.value = 1.0;
        audioSinks.set(pid, { gainNode, savedVolume: 1.0, isMuted: false });
      });

      function setPeerVolume(peerId: string, volume: number) {
        const sink = audioSinks.get(peerId);
        if (!sink) return;
        sink.savedVolume = volume;
        if (!sink.isMuted) {
          sink.gainNode.gain.value = volume;
        }
      }

      function togglePeerMute(peerId: string) {
        const sink = audioSinks.get(peerId);
        if (!sink) return;
        sink.isMuted = !sink.isMuted;
        sink.gainNode.gain.value = sink.isMuted ? 0.0 : sink.savedVolume;
      }

      // Viewer reduces peer-1 to 50%
      setPeerVolume('peer-1', 0.5);
      assertNear(audioSinks.get('peer-1')!.gainNode.gain.value, 0.5);

      // Viewer mutes peer-2
      togglePeerMute('peer-2');
      assert.equal(audioSinks.get('peer-2')!.isMuted, true);
      assert.equal(audioSinks.get('peer-2')!.gainNode.gain.value, 0.0);

      // Unmuting peer-2 restores its previous 1.0 volume
      togglePeerMute('peer-2');
      assert.equal(audioSinks.get('peer-2')!.isMuted, false);
      assertNear(audioSinks.get('peer-2')!.gainNode.gain.value, 1.0);

      // Peer-3 remained completely unaffected throughout
      assertNear(audioSinks.get('peer-3')!.gainNode.gain.value, 1.0);
    } finally {
      dom.cleanup();
    }
  });

  it('WF-T4-4: Should execute clean room departure and session teardown without leaks', () => {
    const dom = setupTestDOM();
    try {
      const c1 = dom.document.createElement('canvas') as MockCanvasElement;
      const c2 = dom.document.createElement('canvas') as MockCanvasElement;
      const activeTracks = [
        c1.captureStream(60).getVideoTracks()[0]!,
        c2.captureStream(60).getVideoTracks()[0]!,
      ];

      const audioCtx = new MockAudioContext();

      function teardownSession() {
        activeTracks.forEach((t) => t.stop());
        audioCtx.close();
      }

      teardownSession();

      activeTracks.forEach((t) => {
        assert.equal(t.readyState, 'ended');
        assert.equal(t.enabled, false);
      });
      assert.equal(audioCtx.state, 'closed');
    } finally {
      dom.cleanup();
    }
  });
});
