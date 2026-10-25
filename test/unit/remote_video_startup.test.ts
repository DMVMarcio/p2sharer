import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeRemoteVideoStartup } from '../../src/video/remote_video_startup.ts';

function fixture(context: any) {
  context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  context.mock.method(performance, 'now', () => Date.now());
  let present!: () => void;
  let recovered = 0, ready = 0, cancelled = 0;
  const element = Object.assign(new EventTarget(), {
    readyState: 0, videoWidth: 0, videoHeight: 0, paused: false, srcObject: null,
    play: async () => {},
    requestVideoFrameCallback(callback: () => void) { present = callback; return 1; },
    cancelVideoFrameCallback() { cancelled++; },
  });
  const dispose = observeRemoteVideoStartup(element as unknown as HTMLVideoElement, {
    mediaId: 'owner/screen', ready: () => ready++, recover: () => recovered++,
  });
  context.after(dispose);
  return { element, dispose, present: () => present(), state: () => ({ recovered, ready, cancelled }) };
}

test('remote startup waits for a presented frame, then stops recovery work', context => {
  const f = fixture(context);
  f.element.dispatchEvent(new Event('playing'));
  assert.equal(f.state().ready, 0, 'A playing event alone does not establish that video decoded');
  f.present();
  context.mock.timers.tick(60_000);
  assert.deepEqual(f.state(), { recovered: 0, ready: 1, cancelled: 0 });
});

test('missing first frame retries after setup grace and two probes, with bounded requests', context => {
  const f = fixture(context);
  for (let probe = 0; probe < 10; probe++) context.mock.timers.tick(1500);
  assert.equal(f.state().recovered, 0);
  context.mock.timers.tick(1500);
  assert.equal(f.state().recovered, 1);
  for (let probe = 0; probe < 40; probe++) context.mock.timers.tick(1500);
  assert.equal(f.state().recovered, 3);
  f.present();
  assert.equal(f.state().ready, 1, 'A late successful frame still removes the waiting state');
});

test('retired video cannot mark a replacement ready or request recovery', context => {
  const f = fixture(context);
  f.dispose();
  f.present();
  context.mock.timers.tick(60_000);
  assert.deepEqual(f.state(), { recovered: 0, ready: 0, cancelled: 1 });
});

test('older players without frame callbacks require decoded dimensions', context => {
  const f = fixture(context);
  f.dispose();
  let ready = 0;
  const element = f.element as any;
  delete element.requestVideoFrameCallback;
  const dispose = observeRemoteVideoStartup(element, { mediaId: 'owner/screen', ready: () => ready++, recover: () => assert.fail() });
  element.dispatchEvent(new Event('loadeddata'));
  assert.equal(ready, 0);
  Object.assign(element, { readyState: 2, videoWidth: 1280, videoHeight: 720 });
  element.dispatchEvent(new Event('timeupdate'));
  assert.equal(ready, 1);
  dispose();
});
