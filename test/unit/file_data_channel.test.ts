import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureFileDataChannelWindow } from '../../src/p2p/file_data_channel.ts';

test('file send restores its channel window after the signaling library resets it', () => {
  const channel = { readyState: 'open', bufferedAmountLowThreshold: 65535 };
  assert.equal(ensureFileDataChannelWindow({ roomDataChannel: channel } as never), true);
  assert.equal(channel.bufferedAmountLowThreshold, 1024 * 1024);
});

test('closed channels cannot be tuned for file sending', () => {
  const channel = { readyState: 'closed', bufferedAmountLowThreshold: 65535 };
  assert.equal(ensureFileDataChannelWindow({ roomDataChannel: channel } as never), false);
  assert.equal(channel.bufferedAmountLowThreshold, 65535);
});
