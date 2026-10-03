import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDOM, MockMediaStream, MockMediaStreamTrack, MockAudioContext } from '../e2e/harness/dom-mock.ts';
import { audioContextManager } from '../../src/audio/audio_context_manager.ts';

function createRoomTestEnvironment() {
  const dom = setupTestDOM();
  audioContextManager.cleanup();
  return { cleanup: () => { audioContextManager.cleanup(); dom.cleanup(); } };
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

describe('Audio sink track lifecycle', () => {
  for (const [label, hasVideo, hasAudio] of [['video-only', true, false], ['audio-only', false, true], ['empty', false, false]] as const) {
    it('handles ' + label + ' streams without creating invalid audio sources', () => {
      const env = createRoomTestEnvironment();
      try {
        const stream = makeStream(label, { hasVideo, hasAudio });
        const sink = audioContextManager.attachPeerAudio(label, stream as any);
        assert.equal(sink.source !== null, hasAudio);
        audioContextManager.setPeerVolume(label, 50);
        assert.equal(audioContextManager.getPeerVolumeState(label).volume, 50);
        assert.doesNotThrow(() => audioContextManager.detachPeerAudio(label));
      } finally { env.cleanup(); }
    });
  }
  it('attaches a source when video-only media is replaced by audio and video', () => {
    const env = createRoomTestEnvironment();
    try {
      const first = audioContextManager.attachPeerAudio('peer', makeStream('first', { hasAudio: false }) as any);
      assert.equal(first.source, null);
      const next = audioContextManager.attachPeerAudio('peer', makeStream('second') as any);
      assert.ok(next.source);
      assert.equal(next.streamId, 'second');
    } finally { env.cleanup(); }
  });
});
