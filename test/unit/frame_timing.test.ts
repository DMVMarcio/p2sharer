import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoFrameClock } from '../../src/video/frame_timing.ts';

test('quantized clock samples remain monotonic without accumulating future frame periods', () => {
  const clock = new VideoFrameClock();
  const frames = Array.from({ length: 8 }, () => clock.next(1000, 120));
  assert.equal(frames[0].timestamp, 1_000_000);
  assert.equal(frames.at(-1)!.timestamp, 1_000_007);
  assert.ok(frames.every((frame, index) => index === 0 || frame.timestamp > frames[index - 1].timestamp));
  assert.equal(clock.next(1500, 120).timestamp, 1_500_000);
});

test('frame duration follows effective FPS while capture generations reset their timestamp state', () => {
  const clock = new VideoFrameClock();
  assert.equal(clock.next(1000, 60).duration, 16_667);
  assert.equal(clock.next(1100, 30).duration, 33_333);
  assert.equal(clock.next(1200, 15).duration, 66_667);
  clock.reset();
  assert.equal(clock.next(5, 120).timestamp, 5000);
  assert.equal(clock.next(6, 120).duration, 8333);
});
