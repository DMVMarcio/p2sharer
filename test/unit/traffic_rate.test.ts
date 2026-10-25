import assert from 'node:assert/strict';
import test from 'node:test';
import { TrafficRateSampler } from '../../src/core/traffic_rate.ts';
import { formatFileSize } from '../../src/core/file_size.ts';

test('traffic rates average recent counter deltas and settle to zero when idle', () => {
  const sampler = new TrafficRateSampler();
  const update = (sent: number, received: number, time: number) => sampler.update({ tunnel: { sent, received } }, time).tunnel;
  assert.deepEqual(update(10000, 20000, 0), { sent: 0, received: 0 });
  assert.deepEqual(update(11000, 22000, 1000), { sent: 1000, received: 2000 });
  assert.deepEqual(update(14000, 26000, 2000), { sent: 2000, received: 3000 });
  assert.deepEqual(update(14000, 26000, 3000), { sent: 1500, received: 2000 });
  assert.deepEqual(update(14000, 26000, 4000), { sent: 0, received: 0 });
});

test('traffic rates use elapsed time and reset after counter rollback, removal or scope teardown', () => {
  const sampler = new TrafficRateSampler();
  sampler.update({ a: { sent: 100, received: 200 } }, 0);
  assert.deepEqual(sampler.update({ a: { sent: 3100, received: 6200 } }, 1500).a, { sent: 2000, received: 4000 });
  assert.deepEqual(sampler.update({ a: { sent: 0, received: 0 } }, 2000).a, { sent: 0, received: 0 });
  sampler.update({}, 3000);
  assert.deepEqual(sampler.update({ a: { sent: 99999, received: 99999 } }, 4000).a, { sent: 0, received: 0 });
  sampler.clear();
  assert.deepEqual(sampler.update({ a: { sent: 99999, received: 99999 } }, 5000).a, { sent: 0, received: 0 });
});

test('binary traffic amounts scale units and preserve two decimal places', () => {
  const options = { binary: true, fractionDigits: 2 };
  assert.equal(formatFileSize(0, options), '0,00 B');
  assert.equal(formatFileSize(1536, options), '1,50 KiB');
  assert.equal(formatFileSize(123.25 * 1024 ** 2, options), '123,25 MiB');
  assert.equal(formatFileSize(1024 ** 3, options), '1,00 GiB');
  assert.equal(formatFileSize(1024 ** 4, options), '1,00 TiB');
});

test('participant rates remain isolated and add up to the overall rate', () => {
  const sampler = new TrafficRateSampler();
  sampler.update({ tunnel: { sent: 100, received: 100, peers: {
    first: { sent: 40, received: 60 }, second: { sent: 60, received: 40 },
  } } }, 0);
  const rates = sampler.update({ tunnel: { sent: 5100, received: 8100, peers: {
    first: { sent: 2040, received: 6060 }, second: { sent: 3060, received: 2040 },
  } } }, 2000).tunnel;
  assert.deepEqual(rates.peers?.first, { sent: 1000, received: 3000 });
  assert.deepEqual(rates.peers?.second, { sent: 1500, received: 1000 });
  assert.equal(rates.sent, rates.peers!.first.sent + rates.peers!.second.sent);
  assert.equal(rates.received, rates.peers!.first.received + rates.peers!.second.received);
});
