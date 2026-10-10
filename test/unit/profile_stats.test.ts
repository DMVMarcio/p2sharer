import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProfileStatistics, parseProfileStats } from '../../src/core/profile_stats.ts';

test('profile totals survive reload and call transitions account only active sessions once', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  let now = 100;
  const stats = new ProfileStatistics(storage, () => now);
  try {
    stats.setInCall(true); stats.setInCall(true);
    now += 60_000; stats.flush();
    now += 10_000; stats.setInCall(false);
    stats.setInCall(false); now += 100_000;
    stats.setInCall(true); now += 20_000; stats.setInCall(false);
    stats.messageSent();
    const loaded = new ProfileStatistics(storage).get()!;
    assert.equal(loaded.callMs, 90_000); assert.equal(loaded.calls, 2);
    assert.equal(loaded.longestCallMs, 70_000); assert.equal(loaded.messages, 1);
  } finally { stats.setInCall(false); }
});

test('an inactive secondary window cannot overwrite statistics updated by the main window on unload', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const main = new ProfileStatistics(storage);
  const secondary = new ProfileStatistics(storage);
  main.messageSent(); secondary.flush();
  assert.equal(new ProfileStatistics(storage).get()!.messages, 1);
});

test('completed transfers exclude previews and duplicates while received snapshots never overwrite local totals', () => {
  const stats = new ProfileStatistics();
  stats.transferCompleted('preview', 'send', 1000, true);
  stats.transferCompleted('send', 'send', 2048);
  stats.transferCompleted('send', 'send', 2048);
  stats.transferCompleted('receive', 'receive', 1024);
  stats.transferCompleted('invalid', 'send', -1);
  assert.equal(stats.get()!.filesSent, 1); assert.equal(stats.get()!.filesReceived, 1);
  assert.equal(stats.get()!.bytesSent, 2048); assert.equal(stats.get()!.bytesReceived, 1024);
  const peer = { ...stats.get()!, messages: 50 };
  let localUpdates = 0;
  stats.subscribeLocal(() => localUpdates++);
  stats.receive('peer', peer);
  assert.equal(stats.get('peer')!.messages, 50); assert.equal(stats.get()!.messages, 0);
  assert.equal(localUpdates, 0, 'Remote updates cannot trigger announcement loops');
  stats.forget('peer'); assert.equal(stats.get('peer'), undefined);
  assert.equal(parseProfileStats({ ...peer, messages: Infinity }), undefined);
  assert.equal(parseProfileStats({ ...peer, longestCallMs: 1 }), undefined);
  assert.equal(parseProfileStats({ ...peer, extra: true }), undefined);
});

test('statistics privacy persists, revokes remote totals and keeps counting locally', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const owner = new ProfileStatistics(storage);
  const viewer = new ProfileStatistics();
  owner.messageSent(); viewer.receive('owner', owner.sharedSnapshot());
  assert.equal(viewer.get('owner')!.messages, 1);
  owner.setSharing(false); owner.messageSent();
  assert.equal(owner.sharedSnapshot(), null);
  viewer.receive('owner', owner.sharedSnapshot());
  assert.equal(viewer.get('owner'), null);
  const loaded = new ProfileStatistics(storage);
  assert.equal(loaded.isSharing(), false); assert.equal(loaded.get()!.messages, 2);
  assert.equal(loaded.sharedSnapshot(), null);
  loaded.setSharing(true); viewer.receive('owner', loaded.sharedSnapshot());
  assert.equal(viewer.get('owner')!.messages, 2);
});
