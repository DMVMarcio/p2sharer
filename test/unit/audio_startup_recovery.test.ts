import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioBridge } from '../../src/audio/audio_bridge.ts';
import { audioContextManager } from '../../src/audio/audio_context_manager.ts';
import { setupTestDOM, MockAudioContext, MockMediaStream, MockMediaStreamTrack } from '../helpers/browser_mocks.ts';

test('sender and viewer recover from a pending autoplay resume without restarting or duplicating PCM resumes', async () => {
  const dom = setupTestDOM();
  const target = new EventTarget();
  let activated = false;
  class GatedContext extends MockAudioContext {
    state = 'suspended' as const;
    calls = 0;
    resume(): Promise<void> {
      this.calls++;
      if (!activated) return new Promise(() => {});
      (this as any).state = 'running';
      return Promise.resolve();
    }
  }
  (globalThis as any).window = Object.assign(target, { AudioContext: GatedContext });
  const originalCreate = dom.document.createElement.bind(dom.document);
  dom.document.createElement = (tag: string) => {
    const element = originalCreate(tag) as any;
    if (tag === 'audio') {
      const play = element.play.bind(element);
      element.play = () => activated ? play() : Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
    }
    return element;
  };
  const bridge = new AudioBridge();
  try {
    bridge.init();
    const stream = new MockMediaStream(); stream.addTrack(new MockMediaStreamTrack('audio'));
    const sink = audioContextManager.attachPeerAudio('receiver', stream as unknown as MediaStream);
    const captureContext = (bridge as any).audioCtx as GatedContext;
    const playbackContext = sink.audioCtx as unknown as GatedContext;
    const chunk = { pcm_base64: Buffer.alloc(480 * 2 * 4).toString('base64'), channels: 2, sample_rate: 48000 };
    for (let i = 0; i < 100; i++) (bridge as any).playPCMChunk(chunk);
    await Promise.resolve();
    assert.equal(captureContext.calls, 1, 'PCM events must share the pending resume');
    assert.equal(playbackContext.calls, 1);
    const element = dom.document.body.children.find(element => element.tagName === 'AUDIO') as any;
    assert.equal(element.paused, true);
    activated = true;
    target.dispatchEvent(new Event('pointerdown'));
    assert.equal(captureContext.state, 'running');
    assert.equal(playbackContext.state, 'running');
    assert.equal(element.paused, false);
    assert.equal(element.volume, 0, 'Web Audio remains the only audible path');
    assert.equal(sink.gainNode.gain.value, 1);
    bridge.stop(); audioContextManager.cleanup();
    const calls = captureContext.calls + playbackContext.calls;
    (captureContext as any).state = (playbackContext as any).state = 'suspended';
    target.dispatchEvent(new Event('keydown'));
    assert.equal(captureContext.calls + playbackContext.calls, calls, 'Teardown removes recovery listeners');
  } finally { bridge.stop(); audioContextManager.cleanup(); dom.cleanup(); }
});

test('an interrupted live capture resumes from the context event without new PCM or a window reload', () => {
  const dom = setupTestDOM();
  const bridge = new AudioBridge();
  const events = new EventTarget();
  class InterruptibleContext extends MockAudioContext {
    addEventListener = events.addEventListener.bind(events);
    removeEventListener = events.removeEventListener.bind(events);
  }
  (globalThis as any).window = Object.assign(new EventTarget(), { AudioContext: InterruptibleContext });
  try {
    bridge.init();
    const context = (bridge as any).audioCtx;
    context.state = 'interrupted';
    events.dispatchEvent(new Event('statechange'));
    assert.equal(context.state, 'running');
  } finally { bridge.stop(); dom.cleanup(); }
});

test('a failed Tauri audio listener can retry and retired listeners cannot feed replacement captures', async context => {
  const dom = setupTestDOM();
  const callbacks: Array<(event: any) => void> = [];
  let attempts = 0;
  (globalThis as any).window = { __TAURI_INTERNALS__: {
    transformCallback: (callback: (event: any) => void) => { callbacks.push(callback); return callbacks.length; },
    invoke: async (command: string) => { if (command === 'write_frontend_log') return;
      if (++attempts === 1) throw new Error('Synthetic listener failure'); return attempts; },
  }, AudioContext: MockAudioContext, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } };
  context.mock.method(console, 'warn', () => {});
  const bridge = new AudioBridge();
  try {
    await assert.rejects(bridge.startCapture(), /Synthetic listener failure/);
    assert.equal((bridge as any).audioCtx, null, 'Failed startup releases its audio context');
    await bridge.startListening();
    bridge.stop();
    await bridge.startListening();
    let chunks = 0;
    (bridge as any).onLevelCallback = () => chunks++;
    callbacks[0]({ payload: { rms_level: 1 } });
    callbacks[1]({ payload: { rms_level: 1 } });
    assert.equal(chunks, 0);
    callbacks[2]({ payload: { rms_level: 1 } });
    assert.equal(chunks, 1);
  } finally { bridge.stop(); dom.cleanup(); }
});
