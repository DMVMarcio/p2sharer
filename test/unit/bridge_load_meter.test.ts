import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeLoadMeter } from '../../src/video/bridge_load_meter.ts';

test('healthy bridge work does not report overload; static ticks supply no evidence', () => {
  const meter = new BridgeLoadMeter(60, 0);
  for (let i = 1; i < 120; i++) {
    meter.complete(3);
    assert.equal(meter.receive(true, false, i * 16), undefined);
  }
  assert.equal(meter.receive(false, false, 2000), undefined);
  assert.equal(meter.receive(true, false, 2001), 18);
  assert.equal(meter.receive(false, false, 50_000), undefined);
});

test('queue replacements and long writes identify pressure independently', () => {
  const replaced = new BridgeLoadMeter(60, 0);
  for (let i = 0; i < 99; i++) { replaced.complete(1); replaced.receive(true, i < 25, i * 20); }
  assert.equal(replaced.receive(true, false, 2000), 100);
  const slow = new BridgeLoadMeter(120, 0);
  for (let i = 0; i < 30; i++) { slow.complete(10); slow.receive(true, false, i * 50); }
  assert.equal(slow.receive(true, false, 2000), 120);
});

test('sparse sources, spikes and invalid timing samples do not imply sustained overload', () => {
  const meter = new BridgeLoadMeter(60, 0);
  meter.complete(NaN); meter.complete(-1);
  meter.complete(100);
  assert.equal(meter.receive(true, false, 2000), undefined);
  for (let i = 0; i < 119; i++) { meter.complete(2); meter.receive(true, false, 2001 + i * 16); }
  assert.equal(meter.receive(true, false, 4001), 12);
});

test('bridge work uses the effective frame budget after native adaptation', () => {
  const meter = new BridgeLoadMeter(60, 0);
  meter.setEffectiveFps(30);
  meter.setEffectiveFps(NaN);
  meter.setEffectiveFps(0);
  for (let i = 0; i < 59; i++) { meter.complete(12); meter.receive(true, false, i * 30); }
  assert.equal(meter.receive(true, false, 2000), 36);
});
