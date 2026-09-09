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
import { audioContextManager, AudioContextManager } from '../../src/audio/audio_context_manager.ts';
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

  const stoppedPeers: string[] = [];
  const requestedPeers: string[] = [];

  const callbacks = {
    onRequestStream: (peerId: string) => {
      requestedPeers.push(peerId);
    },
    onStopWatchingStream: (peerId: string) => {
      stoppedPeers.push(peerId);
    },
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
    stoppedPeers,
    requestedPeers,
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

describe('M5 Adversarial Stress Challenge: GPU Decoder Dismantling & AudioContext Scaling', () => {

  describe('Adversarial Challenge 1: GPU Decoder Dismantling Stress Tests', () => {
    it('1.1: Peer Stop Streaming — Video paused, srcObject null, loadCount > 0, and audio sink detached', () => {
      const env = createRoomTestEnvironment();
      try {
        const stream = makeStream('stream-peer1');
        const slot: RoomSlotInfo = {
          peerId: 'peer1',
          senderName: 'Alice',
          color: '#ff4444',
          isStreaming: true,
          isLocal: false,
          stream: stream as any,
        };

        stateStore.roomSlots = [slot];
        stateStore.subscribedStreams.add('peer1');

        env.renderer.renderRoomCards();

        const card = env.gridWrapper.children[0] as MockElement;
        const video = card.querySelector('video') as MockVideoElement;
        assert.ok(video, 'Video element must be present initially');
        assert.strictEqual(video.srcObject, stream);
        assert.equal(video.paused, false);

        // Verify audio sink is attached
        const sinksBefore = (audioContextManager as any).peerSinks as Map<string, any>;
        assert.ok(sinksBefore.has('peer1'), 'Audio sink must be attached initially');

        // Trigger peer stop streaming
        stateStore.roomSlots[0]!.isStreaming = false;
        stateStore.roomSlots[0]!.stream = null;

        env.renderer.renderRoomCards();

        // Assert 4-step GPU decoder release
        assert.equal(video.paused, true, 'video.paused must be true upon peer stop');
        assert.equal(video.srcObject, null, 'video.srcObject must be null upon peer stop');
        assert.ok(video.loadCount > 0, 'video.loadCount must be > 0 (hardware decoder surface released)');

        // Assert audio sink detached
        const sinksAfter = (audioContextManager as any).peerSinks as Map<string, any>;
        assert.equal(sinksAfter.has('peer1'), false, 'Audio sink must be detached upon peer stop');
      } finally {
        env.cleanup();
      }
    });

    it('1.2: Peer Unsubscribe ("Parar de Assistir") — Video paused, srcObject null, loadCount > 0, and audio sink detached', () => {
      const env = createRoomTestEnvironment();
      try {
        const stream = makeStream('stream-peer2');
        const slot: RoomSlotInfo = {
          peerId: 'peer2',
          senderName: 'Bob',
          color: '#44ff44',
          isStreaming: true,
          isLocal: false,
          stream: stream as any,
        };

        stateStore.roomSlots = [slot];
        stateStore.subscribedStreams.add('peer2');

        env.renderer.renderRoomCards();

        const card = env.gridWrapper.children[0] as MockElement;
        const video = card.querySelector('video') as MockVideoElement;
        assert.ok(video, 'Video element must exist');

        const stopBtn = card.querySelector('.btn-stop-watch-stream') as MockElement;
        assert.ok(stopBtn, 'Stop watching button must be present');

        // Click unsubscribe
        stopBtn.click();

        assert.equal(env.stoppedPeers.includes('peer2'), true, 'Stop watching callback invoked');
        assert.equal(stateStore.subscribedStreams.has('peer2'), false, 'Unsubscribed in stateStore');

        // Assert 4-step GPU release
        assert.equal(video.paused, true, 'video.paused must be true upon unsubscribe');
        assert.equal(video.srcObject, null, 'video.srcObject must be null upon unsubscribe');
        assert.ok(video.loadCount > 0, 'video.loadCount must be > 0 upon unsubscribe');

        // Assert audio sink detached
        const sinks = (audioContextManager as any).peerSinks as Map<string, any>;
        assert.equal(sinks.has('peer2'), false, 'Audio sink must be detached upon unsubscribe');
      } finally {
        env.cleanup();
      }
    });

    it('1.3: Peer Room Leave — Video paused, srcObject null, loadCount > 0, and audio sink detached', () => {
      const env = createRoomTestEnvironment();
      try {
        const streamA = makeStream('stream-A');
        const streamB = makeStream('stream-B');

        stateStore.roomSlots = [
          { peerId: 'peerA', senderName: 'Alice', color: '#f00', isStreaming: true, isLocal: false, stream: streamA as any },
          { peerId: 'peerB', senderName: 'Bob', color: '#0f0', isStreaming: true, isLocal: false, stream: streamB as any },
        ];
        stateStore.subscribedStreams.add('peerA');
        stateStore.subscribedStreams.add('peerB');

        env.renderer.renderRoomCards();

        const cardB = env.gridWrapper.children[1] as MockElement;
        const videoB = cardB.querySelector('video') as MockVideoElement;
        assert.ok(videoB);

        // Peer B departs room
        stateStore.roomSlots = [stateStore.roomSlots[0]!];
        stateStore.subscribedStreams.delete('peerB');

        env.renderer.renderRoomCards();

        // Peer B GPU decoder dismantle verified
        assert.equal(videoB.paused, true, 'Departed peer video must be paused');
        assert.equal(videoB.srcObject, null, 'Departed peer video.srcObject must be null');
        assert.ok(videoB.loadCount > 0, 'Departed peer video.loadCount must be > 0');

        const sinks = (audioContextManager as any).peerSinks as Map<string, any>;
        assert.equal(sinks.has('peerB'), false, 'Departed peer audio sink must be detached');
        assert.equal(sinks.has('peerA'), true, 'Remaining peer audio sink remains active');
      } finally {
        env.cleanup();
      }
    });

    it('1.4: Complete Room Teardown via clear() — All videos paused, srcObject null, loadCount > 0, all sinks detached', () => {
      const env = createRoomTestEnvironment();
      try {
        const videos: MockVideoElement[] = [];
        for (let i = 1; i <= 5; i++) {
          const stream = makeStream(`stream-${i}`);
          stateStore.roomSlots.push({
            peerId: `peer-${i}`,
            senderName: `User ${i}`,
            color: '#333',
            isStreaming: true,
            isLocal: false,
            stream: stream as any,
          });
          stateStore.subscribedStreams.add(`peer-${i}`);
        }

        env.renderer.renderRoomCards();

        for (let i = 0; i < 5; i++) {
          const card = env.gridWrapper.children[i] as MockElement;
          const video = card.querySelector('video') as MockVideoElement;
          assert.ok(video);
          videos.push(video);
        }

        // Room unmount / clear
        env.renderer.clear();

        for (let i = 0; i < 5; i++) {
          assert.equal(videos[i]!.paused, true, `Video ${i + 1} paused on clear`);
          assert.equal(videos[i]!.srcObject, null, `Video ${i + 1} srcObject null on clear`);
          assert.ok(videos[i]!.loadCount > 0, `Video ${i + 1} loadCount > 0 on clear`);
        }

        const sinks = (audioContextManager as any).peerSinks as Map<string, any>;
        assert.equal(sinks.size, 0, 'All audio sinks detached on clear');
        assert.equal((env.renderer as any).cachedCards.size, 0, 'Cached cards map completely pruned');
      } finally {
        env.cleanup();
      }
    });

    it('1.5: High-Frequency Churn Stress (10 peers cycling join/stream/unsubscribe/stop/leave 20 times)', () => {
      const env = createRoomTestEnvironment();
      try {
        const allCreatedVideos: MockVideoElement[] = [];

        for (let cycle = 0; cycle < 20; cycle++) {
          // Phase 1: 10 peers join and stream
          stateStore.roomSlots = [];
          for (let i = 1; i <= 10; i++) {
            const stream = makeStream(`cycle-${cycle}-peer-${i}`);
            stateStore.roomSlots.push({
              peerId: `peer-${i}`,
              senderName: `Peer ${i}`,
              color: '#123456',
              isStreaming: true,
              isLocal: false,
              stream: stream as any,
            });
            stateStore.subscribedStreams.add(`peer-${i}`);
          }
          env.renderer.renderRoomCards();

          // Collect current video elements
          for (const card of env.gridWrapper.children) {
            const v = card.querySelector('video') as MockVideoElement;
            if (v && !allCreatedVideos.includes(v)) {
              allCreatedVideos.push(v);
            }
          }

          // Phase 2: Half unsubscribe, half stop streaming
          for (let i = 1; i <= 5; i++) {
            stateStore.subscribedStreams.delete(`peer-${i}`);
          }
          for (let i = 6; i <= 10; i++) {
            stateStore.roomSlots[i - 1]!.isStreaming = false;
            stateStore.roomSlots[i - 1]!.stream = null;
          }
          env.renderer.renderRoomCards();

          // Phase 3: All 10 leave
          stateStore.roomSlots = [];
          stateStore.subscribedStreams.clear();
          env.renderer.renderRoomCards();
        }

        // Final verification: all dismantled videos must have paused=true, srcObject=null, loadCount>0
        assert.ok(allCreatedVideos.length > 0, 'Should have created video elements during cycles');
        for (const v of allCreatedVideos) {
          assert.equal(v.paused, true, 'Dismantled churn video must be paused');
          assert.equal(v.srcObject, null, 'Dismantled churn video srcObject must be null');
          assert.ok(v.loadCount > 0, 'Dismantled churn video loadCount must be > 0');
        }

        const cachedCards = (env.renderer as any).cachedCards as Map<string, any>;
        assert.equal(cachedCards.size, 0, 'All cached cards purged after all peers left');
        assert.equal(env.gridWrapper.children.length, 0, 'Grid empty');
      } finally {
        env.cleanup();
      }
    });
  });

  describe('Adversarial Challenge 2: AudioContext Scaling (20 Concurrent Streams)', () => {
    it('2.1: Strictly 1 AudioContext instantiated across 20 concurrent remote peer streams with zero DOMException', () => {
      const env = createRoomTestEnvironment();
      try {
        MockAudioContext.instanceCount = 0;
        let exceptionCount = 0;

        for (let i = 1; i <= 20; i++) {
          try {
            const stream = makeStream(`stream-concurrent-${i}`, { hasAudio: true, hasVideo: true });
            audioContextManager.attachPeerAudio(`peer-${i}`, stream as any);
          } catch (err) {
            exceptionCount++;
          }
        }

        assert.equal(exceptionCount, 0, 'Must have zero DOMExceptions when attaching 20 streams');
        assert.equal(
          MockAudioContext.instanceCount,
          1,
          'Must strictly instantiate 1 AudioContext across 20 concurrent streams (browser 6-context ceiling preserved)'
        );

        const sinks = (audioContextManager as any).peerSinks as Map<string, any>;
        assert.equal(sinks.size, 20, 'All 20 streams must be recorded in peerSinks');
      } finally {
        env.cleanup();
      }
    });

    it('2.2: Independent volume control across 20 concurrent streams — isolated GainNodes', () => {
      const env = createRoomTestEnvironment();
      try {
        for (let i = 1; i <= 20; i++) {
          const stream = makeStream(`stream-vol-${i}`, { hasAudio: true });
          audioContextManager.attachPeerAudio(`peer-${i}`, stream as any);
        }

        // Assign distinct volumes: peer 1 = 5%, peer 2 = 10%, ..., peer 20 = 100%
        for (let i = 1; i <= 20; i++) {
          const expectedVol = i * 5;
          audioContextManager.setPeerVolume(`peer-${i}`, expectedVol);
        }

        const sinks = (audioContextManager as any).peerSinks as Map<string, any>;

        // Verify each peer has independent volume and gain value
        for (let i = 1; i <= 20; i++) {
          const expectedVol = i * 5;
          const state = audioContextManager.getPeerVolumeState(`peer-${i}`);
          assert.equal(state.volume, expectedVol, `Peer ${i} volume state matches`);
          assert.equal(state.isMuted, false);

          const sink = sinks.get(`peer-${i}`);
          assert.ok(sink, `Sink for peer ${i} must exist`);
          const expectedGain = expectedVol / 100;
          assert.ok(
            Math.abs(sink.gainNode.gain.value - expectedGain) < 0.0001,
            `Peer ${i} gainNode matches ${expectedGain}`
          );
        }

        // Mute only odd-numbered peers (1, 3, 5, ..., 19)
        for (let i = 1; i <= 20; i += 2) {
          const currVol = audioContextManager.getPeerVolumeState(`peer-${i}`).volume;
          audioContextManager.setPeerVolume(`peer-${i}`, currVol, true);
        }

        // Verify odd peers are muted and even peers retain their volume
        for (let i = 1; i <= 20; i++) {
          const sink = sinks.get(`peer-${i}`);
          const state = audioContextManager.getPeerVolumeState(`peer-${i}`);
          if (i % 2 === 1) {
            assert.equal(state.isMuted, true, `Peer ${i} must be muted`);
            assert.equal(sink.gainNode.gain.value, 0, `Peer ${i} gainNode must be 0`);
          } else {
            assert.equal(state.isMuted, false, `Peer ${i} must NOT be muted`);
            const expectedGain = (i * 5) / 100;
            assert.ok(
              Math.abs(sink.gainNode.gain.value - expectedGain) < 0.0001,
              `Peer ${i} gainNode must remain ${expectedGain}`
            );
          }
        }
      } finally {
        env.cleanup();
      }
    });

    it('2.3: Dynamic partial detachment (detach 10 of 20) and re-attachment preserving single context', () => {
      const env = createRoomTestEnvironment();
      try {
        MockAudioContext.instanceCount = 0;

        for (let i = 1; i <= 20; i++) {
          const stream = makeStream(`stream-detach-${i}`);
          audioContextManager.attachPeerAudio(`peer-${i}`, stream as any);
        }

        assert.equal(MockAudioContext.instanceCount, 1);
        const sinks = (audioContextManager as any).peerSinks as Map<string, any>;
        assert.equal(sinks.size, 20);

        // Detach 10 peers (1 to 10)
        for (let i = 1; i <= 10; i++) {
          audioContextManager.detachPeerAudio(`peer-${i}`);
        }

        assert.equal(sinks.size, 10, '10 peers remain in sinks');
        for (let i = 1; i <= 10; i++) {
          assert.equal(sinks.has(`peer-${i}`), false);
        }
        for (let i = 11; i <= 20; i++) {
          assert.equal(sinks.has(`peer-${i}`), true);
        }

        // Re-attach 10 new peers (21 to 30)
        for (let i = 21; i <= 30; i++) {
          const stream = makeStream(`stream-detach-${i}`);
          audioContextManager.attachPeerAudio(`peer-${i}`, stream as any);
        }

        assert.equal(sinks.size, 20, '20 peers active again');
        assert.equal(
          MockAudioContext.instanceCount,
          1,
          'AudioContext instance count must remain strictly 1'
        );
      } finally {
        env.cleanup();
      }
    });

    it('2.4: Full AudioContextManager cleanup and recovery across room transitions', () => {
      const env = createRoomTestEnvironment();
      try {
        MockAudioContext.instanceCount = 0;

        for (let i = 1; i <= 5; i++) {
          const stream = makeStream(`room1-peer-${i}`);
          audioContextManager.attachPeerAudio(`peer-${i}`, stream as any);
        }
        assert.equal(MockAudioContext.instanceCount, 1);

        // First room teardown
        audioContextManager.cleanup();

        const sinksAfterCleanup = (audioContextManager as any).peerSinks as Map<string, any>;
        assert.equal(sinksAfterCleanup.size, 0, 'Sinks must be empty after cleanup');
        assert.equal((audioContextManager as any).audioCtx, null, 'audioCtx reference must be nullified');

        // Second room start
        for (let i = 1; i <= 5; i++) {
          const stream = makeStream(`room2-peer-${i}`);
          audioContextManager.attachPeerAudio(`room2-peer-${i}`, stream as any);
        }

        assert.equal(
          MockAudioContext.instanceCount,
          2,
          'A fresh single AudioContext is instantiated for new room session'
        );
        assert.equal(sinksAfterCleanup.size, 5);
      } finally {
        env.cleanup();
      }
    });
  });

  describe('Adversarial Challenge 3: Stream Edge Cases (Missing Tracks & Zero-Track Streams)', () => {
    it('3.1: Stream WITHOUT audio tracks — zero exceptions, no invalid AudioContext source creation', () => {
      const env = createRoomTestEnvironment();
      try {
        // Enforce strict W3C AudioContext oracle: throw DOMException if createMediaStreamSource is passed a stream with 0 audio tracks
        const origCreateMediaStreamSource = MockAudioContext.prototype.createMediaStreamSource;
        let illegalMethodCallCount = 0;

        MockAudioContext.prototype.createMediaStreamSource = function (stream: any) {
          if (!stream.getAudioTracks || stream.getAudioTracks().length === 0) {
            illegalMethodCallCount++;
            throw new Error('DOMException: MediaStream has no audio tracks');
          }
          return origCreateMediaStreamSource.call(this, stream);
        };

        try {
          // Stream with video only (0 audio tracks)
          const videoOnlyStream = makeStream('video-only-stream', { hasVideo: true, hasAudio: false });
          assert.equal(videoOnlyStream.getAudioTracks().length, 0);
          assert.equal(videoOnlyStream.getVideoTracks().length, 1);

          // Direct test in AudioContextManager
          const sink = audioContextManager.attachPeerAudio('video-peer', videoOnlyStream as any);
          assert.ok(sink, 'Sink returned cleanly');
          assert.equal(sink.source, null, 'Source must remain null for audio-trackless stream');
          assert.equal(illegalMethodCallCount, 0, 'createMediaStreamSource must NOT have been invoked');

          // Volume operations on audio-trackless stream
          audioContextManager.setPeerVolume('video-peer', 50);
          assert.equal(audioContextManager.getPeerVolumeState('video-peer').volume, 50);

          // Full renderer test with video-only stream
          stateStore.roomSlots = [
            {
              peerId: 'video-peer',
              senderName: 'VideoOnlyUser',
              color: '#abcdef',
              isStreaming: true,
              isLocal: false,
              stream: videoOnlyStream as any,
            },
          ];
          stateStore.subscribedStreams.add('video-peer');

          assert.doesNotThrow(() => {
            env.renderer.renderRoomCards();
          }, 'ViewerRenderer must not throw on video-only stream');

          const card = env.gridWrapper.children[0] as MockElement;
          const video = card.querySelector('video') as MockVideoElement;
          assert.ok(video, 'Video element must be rendered');
          assert.strictEqual(video.srcObject, videoOnlyStream);

          // Detach safely
          assert.doesNotThrow(() => {
            audioContextManager.detachPeerAudio('video-peer');
          });
        } finally {
          MockAudioContext.prototype.createMediaStreamSource = origCreateMediaStreamSource;
        }
      } finally {
        env.cleanup();
      }
    });

    it('3.2: Stream WITHOUT video tracks (audio only) — zero crashes in ViewerRenderer and AudioContextManager', () => {
      const env = createRoomTestEnvironment();
      try {
        const audioOnlyStream = makeStream('audio-only-stream', { hasVideo: false, hasAudio: true });
        assert.equal(audioOnlyStream.getVideoTracks().length, 0);
        assert.equal(audioOnlyStream.getAudioTracks().length, 1);

        stateStore.roomSlots = [
          {
            peerId: 'audio-peer',
            senderName: 'AudioOnlyUser',
            color: '#112233',
            isStreaming: true,
            isLocal: false,
            stream: audioOnlyStream as any,
          },
        ];
        stateStore.subscribedStreams.add('audio-peer');

        assert.doesNotThrow(() => {
          env.renderer.renderRoomCards();
        }, 'ViewerRenderer must not crash on audio-only stream');

        const card = env.gridWrapper.children[0] as MockElement;
        const video = card.querySelector('video') as MockVideoElement;
        assert.ok(video, 'HTMLVideoElement exists for media playback');
        assert.strictEqual(video.srcObject, audioOnlyStream);

        // Audio sink is connected
        const sinks = (audioContextManager as any).peerSinks as Map<string, any>;
        assert.ok(sinks.has('audio-peer'), 'Audio sink must be active for audio-only stream');
        assert.ok(sinks.get('audio-peer').source !== null, 'Audio source must be connected');
      } finally {
        env.cleanup();
      }
    });

    it('3.3: Stream with ZERO tracks (completely empty MediaStream) — clean handling without uncaught errors', () => {
      const env = createRoomTestEnvironment();
      try {
        const emptyStream = makeStream('empty-stream', { hasVideo: false, hasAudio: false });
        assert.equal(emptyStream.getTracks().length, 0);

        stateStore.roomSlots = [
          {
            peerId: 'empty-peer',
            senderName: 'EmptyUser',
            color: '#999999',
            isStreaming: true,
            isLocal: false,
            stream: emptyStream as any,
          },
        ];
        stateStore.subscribedStreams.add('empty-peer');

        assert.doesNotThrow(() => {
          env.renderer.renderRoomCards();
        }, 'Must not throw when stream has 0 tracks');

        const card = env.gridWrapper.children[0] as MockElement;
        const video = card.querySelector('video') as MockVideoElement;
        assert.ok(video);
        assert.strictEqual(video.srcObject, emptyStream);

        const sinks = (audioContextManager as any).peerSinks as Map<string, any>;
        assert.ok(sinks.has('empty-peer'));
        assert.equal(sinks.get('empty-peer').source, null, 'Source remains null for empty stream');
      } finally {
        env.cleanup();
      }
    });

    it('3.4: Stream track swap (re-negotiation from video-only to audio+video) updates source seamlessly', () => {
      const env = createRoomTestEnvironment();
      try {
        // Stream starts as video-only
        const stream1 = makeStream('stream-track-swap-1', { hasVideo: true, hasAudio: false });
        stateStore.roomSlots = [
          {
            peerId: 'swap-peer',
            senderName: 'Swapper',
            color: '#555',
            isStreaming: true,
            isLocal: false,
            stream: stream1 as any,
          },
        ];
        stateStore.subscribedStreams.add('swap-peer');

        env.renderer.renderRoomCards();
        const sinks = (audioContextManager as any).peerSinks as Map<string, any>;
        assert.equal(sinks.get('swap-peer').source, null);

        // Stream upgraded to include audio with new stream ID
        const stream2 = makeStream('stream-track-swap-2', { hasVideo: true, hasAudio: true });
        stateStore.roomSlots[0]!.stream = stream2 as any;

        env.renderer.renderRoomCards();

        assert.ok(sinks.get('swap-peer').source !== null, 'Audio source must be connected on upgrade');
        assert.equal(sinks.get('swap-peer').streamId, 'stream-track-swap-2');
      } finally {
        env.cleanup();
      }
    });
  });
});
