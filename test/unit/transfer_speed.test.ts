import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTransferSpeed } from '../../src/core/transfer_speed.ts';

test('transfer speed switches between decimal megabytes and megabits per second', () => {
  assert.equal(formatTransferSpeed(1_000_000, 'MB'), '1,0 MB/s');
  assert.equal(formatTransferSpeed(1_000_000, 'Mb'), '8,0 Mb/s');
  assert.equal(formatTransferSpeed(125_000, 'MB'), '0,13 MB/s');
  assert.equal(formatTransferSpeed(125_000, 'Mb'), '1,0 Mb/s');
});
