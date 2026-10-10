import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

let nativeCalls = 0;
globalThis.__profileInvoke = async (command, args) => {
  assert.equal(command, 'validate_profile_image'); nativeCalls++;
  if (args.data === 'AAAA') throw new Error('Invalid image');
  return `data:image/png;base64,${args.data}`;
};
const bundle = await build({
  stdin: { contents: `export { ProfileTransfer } from './src/p2p/profile_transfer.ts'; export { profileImages } from './src/core/profile_image.ts'; export { contrastingTextColor } from './src/core/accent_color.ts';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'native', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'native', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const invoke = (command, args) => globalThis.__profileInvoke(command, args);' }));
  } }],
});
const { ProfileTransfer, profileImages } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const hash = 'a'.repeat(64);
const offer = (hash = 'a'.repeat(64)) => ({ kind: 'offer', hash, color: '#123456', size: 4 });

test('image display requires an admitted offer, matching request and successful native validation; hashes deduplicate', async () => {
  const sent = [];
  const transfer = new ProfileTransfer((packet, peer) => { if (packet.kind !== 'offer') sent.push({ packet, peer }); }, peer => peer !== 'stranger');
  try {
    await transfer.receive(offer(), 'stranger'); assert.equal(sent.length, 0);
    await transfer.receive({ kind: 'chunk', hash, token: 'unsolicited', index: 0, data: 'YQ==' }, 'peer');
    assert.equal(nativeCalls, 0);
    await transfer.receive(offer(), 'peer');
    assert.equal(sent[0].packet.kind, 'request');
    const token = sent[0].packet.token;
    await transfer.receive({ kind: 'chunk', hash, token: 'wrong', index: 0, data: 'YQ==' }, 'peer');
    await transfer.receive({ kind: 'chunk', hash, token, index: 1, data: 'YQ==' }, 'peer');
    assert.equal(nativeCalls, 0);
    await transfer.receive({ kind: 'chunk', hash, token, index: 0, data: 'YQ==' }, 'peer');
    assert.equal(nativeCalls, 1);
    assert.equal(profileImages.url('peer'), 'data:image/png;base64,YQ==');
    await transfer.receive({ ...offer(), cardColor: '#ff8844' }, 'other');
    assert.equal(profileImages.background('other'), '#ff8844');
    assert.equal(sent.length, 1);
    assert.equal(profileImages.url('other'), profileImages.url('peer'));
    await transfer.receive({ kind: 'offer', hash: '', size: 0, color: '#654321' }, 'peer');
    assert.equal(profileImages.url('peer'), undefined);
    assert.equal(profileImages.color('peer'), '#654321');
    assert.equal(profileImages.background('peer'), '#654321');
    await transfer.receive({ kind: 'offer', hash: '', size: 0, color: '#654321', cardColor: '#abcdef' }, 'peer');
    assert.equal(profileImages.background('peer'), '#abcdef');
    assert.equal(sent.length, 1);
  } finally { transfer.close(); }
});

test('invalid images, metadata and superseded transfer tokens never render', async () => {
  const sent = [];
  const transfer = new ProfileTransfer((packet, peer) => { if (packet.kind !== 'offer') sent.push({ packet, peer }); }, () => true);
  const badHash = 'b'.repeat(64);
  try {
    await transfer.receive({ ...offer(badHash), size: 20_000_000 }, 'peer');
    await transfer.receive({ ...offer(badHash), color: 'url(example)' }, 'peer');
    await transfer.receive({ ...offer(badHash), cardColor: 'url(example)' }, 'peer');
    assert.equal(sent.length, 0);
    await transfer.receive(offer(badHash), 'peer');
    const token = sent[0].packet.token;
    await transfer.receive({ kind: 'chunk', hash: badHash, token, index: 0, data: 'AAAA' }, 'peer');
    assert.equal(profileImages.url('peer'), undefined);
    await transfer.receive({ kind: 'offer', hash: '', size: 0, color: '#123456' }, 'peer');
    await transfer.receive({ kind: 'chunk', hash: badHash, token, index: 0, data: 'YQ==' }, 'peer');
    assert.equal(profileImages.url('peer'), undefined);
    await transfer.receive({ kind: 'request', hash: badHash, token }, 'peer');
    assert.equal(sent.length, 1);
  } finally { transfer.close(); }
});

test('waiting room offers continue after the bounded request queue drains', async () => {
  const sent = [];
  const transfer = new ProfileTransfer((packet, peer) => { if (packet.kind !== 'offer') sent.push({ packet, peer }); }, () => true);
  try {
    for (let i = 1; i <= 5; i++) await transfer.receive(offer(String(i).repeat(64)), `peer${i}`);
    assert.equal(sent.length, 4);
    const { token, hash } = sent[0].packet;
    await transfer.receive({ kind: 'chunk', hash, token, index: 0, data: 'YQ==' }, 'peer1');
    assert.equal(sent.length, 5);
    assert.equal(sent[4].peer, 'peer5');
  } finally { transfer.close(); }
});

test('rapid changes coalesce to the latest image and admission readiness exchanges offers', async () => {
  const originals = { interval: globalThis.setInterval, clear: globalThis.clearInterval, now: Date.now };
  let tick;
  let now = 10000;
  globalThis.setInterval = fn => { tick = fn; return { unref() {} }; };
  globalThis.clearInterval = () => {};
  Date.now = () => now;
  const sent = [];
  const transfer = new ProfileTransfer((packet, peer) => sent.push({ packet, peer }), () => true);
  try {
    await transfer.receive(offer('c'.repeat(64)), 'peer');
    assert.ok(sent.some(({ packet }) => packet.kind === 'offer'), 'First inbound offer confirms readiness and receives local metadata');
    await transfer.receive(offer('d'.repeat(64)), 'peer');
    await transfer.receive(offer('e'.repeat(64)), 'peer');
    now += 5000; tick();
    assert.equal(profileImages.peers.get('peer').hash, 'e'.repeat(64));
    assert.ok(sent.some(({ packet }) => packet.kind === 'request' && packet.hash === 'e'.repeat(64)));
    await transfer.receive(offer('f'.repeat(64)), 'peer');
    await transfer.receive({ kind: 'offer', hash: '', size: 0, color: '#123456' }, 'peer');
    now += 5000; tick();
    assert.equal(profileImages.peers.get('peer').hash, '', 'Removal cancels a deferred replacement');
  } finally {
    transfer.close(); globalThis.setInterval = originals.interval;
    globalThis.clearInterval = originals.clear; Date.now = originals.now;
  }
});

test('automatic card tone is announced to peers while manual card colors remain exact', async () => {
  const local = profileImages.local;
  const packets = [];
  const transfer = new ProfileTransfer(packet => packets.push(packet), () => true);
  try {
    profileImages.local = { hash: '', data: '', color: '#00ff00', dominantColor: '#ffff00', cardColor: null };
    await transfer.announce('viewer');
    const automatic = packets.at(-1).cardColor;
    assert.equal(automatic, profileImages.background('local'));
    assert.notEqual(automatic, '#ffff00');
    await transfer.receive({ ...packets.at(-1) }, 'viewer');
    assert.equal(profileImages.background('viewer'), automatic);
    assert.equal(profileImages.color('viewer'), '#00ff00', 'Avatar fallback is independent of the card tone');
    profileImages.local = { ...profileImages.local, cardColor: '#ffffff' };
    await transfer.announce('viewer');
    assert.equal(packets.at(-1).cardColor, '#ffffff');
    assert.equal(profileImages.background('local'), '#ffffff');
  } finally { transfer.close(); profileImages.local = local; profileImages.forget('viewer'); }
});


test('new profiles persist a random color with white text; saved colors survive initialization', async () => {
  const originalInvoke = globalThis.__profileInvoke;
  const originalWindow = globalThis.window;
  const originalRandom = Math.random;
  let saved = null;
  let writes = 0;
  globalThis.window = { __TAURI_INTERNALS__: {} };
  globalThis.__profileInvoke = async (command, args) => {
    if (command === 'load_profile_image') return saved;
    assert.equal(command, 'save_profile_image');
    assert.equal(args.token, null);
    assert.equal(args.remove, false);
    writes++;
    return saved = { hash: '', data: '', color: args.color, cardColor: args.cardColor };
  };
  const load = async suffix => {
    const source = bundle.outputFiles[0].text + `\n// isolated profile fixture ${suffix}`;
    const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    await module.profileImages.ready;
    return module;
  };
  try {
    const colors = new Set();
    for (let hue = 0; hue < 360; hue += 10) {
      saved = null; Math.random = () => hue / 360;
      const { profileImages: profile, contrastingTextColor } = await load(`hue-${hue}`);
      assert.equal(contrastingTextColor(profile.local.color), '#ffffff');
      assert.equal(profile.local.color, saved.color);
      colors.add(saved.color);
    }
    assert.ok(colors.size > 1);
    const writeCount = writes;
    const color = saved.color;
    Math.random = () => 0.5;
    assert.equal((await load('reload')).profileImages.local.color, color);
    saved = { hash: '', data: '', color: '#ffffff', cardColor: '#123456' };
    assert.deepEqual((await load('custom')).profileImages.local, saved);
    assert.equal(writes, writeCount);
  } finally {
    Math.random = originalRandom;
    globalThis.__profileInvoke = originalInvoke;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
