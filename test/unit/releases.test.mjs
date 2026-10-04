import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRelease, setVersion, validateVersion, validatePublicKey, normalizePublicKey, normalizeConfiguredPublicKey, verifyArtifacts } from '../../tools/release.mjs';

const config = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
test('release version updates all declarations without changing dependency versions', () => {
  const root = mkdtempSync(join(tmpdir(), 'p2sharer-release-'));
  try {
    mkdirSync(join(root, 'src-tauri'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0', dependencies: { fixture: '1.0.0' } }));
    writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify(config));
    writeFileSync(join(root, 'src-tauri/Cargo.toml'), '[package]\nname = "p2sharer"\nversion = "1.0.0"\n\n[dependencies]\nfixture = "1.0.0"\n');
    writeFileSync(join(root, 'src-tauri/Cargo.lock'), '[[package]]\nname = "p2sharer"\nversion = "1.0.0"\n\n[[package]]\nname = "fixture"\nversion = "1.0.0"\n');
    setVersion('1.1.0-beta.1', root);
    assert.equal(checkRelease(root, 'v1.1.0-beta.1'), '1.1.0-beta.1');
    assert.throws(() => checkRelease(root, 'v1.1.0'), /tag/);
    assert.match(readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8'), /name = "fixture"\nversion = "1.0.0"/);
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies.fixture, '1.0.0');
    // Synthetic signatures exercise key identity validation, not cryptographic verification.
    const rawSignature = Buffer.alloc(74);
    const publicLines = Buffer.from(config.plugins.updater.pubkey, 'base64').toString('utf8').trim().split(/\r?\n/);
    Buffer.from(publicLines[1], 'base64').subarray(2, 10).copy(rawSignature, 2);
    const signature = Buffer.from(`untrusted comment: test fixture\n${rawSignature.toString('base64')}\n`).toString('base64');
    const manifest = { version: '1.1.0-beta.1', platforms: {
      'windows-x86_64-nsis': { signature, url: 'https://api.github.com/repos/DMVMarcio/p2sharer/releases/assets/1' },
      'windows-x86_64-msi': { signature, url: 'https://api.github.com/repos/DMVMarcio/p2sharer/releases/assets/2' },
    } };
    const saveManifest = () => writeFileSync(join(root, 'latest.json'), JSON.stringify(manifest));
    saveManifest();
    assert.equal(verifyArtifacts(root), '1.1.0-beta.1');
    manifest.platforms['windows-x86_64-msi'].signature = Buffer.from('wrong-key fixture').toString('base64');
    saveManifest();
    assert.throws(() => verifyArtifacts(root), /signing key/);
    manifest.platforms['windows-x86_64-msi'].signature = signature;
    manifest.platforms['windows-x86_64-msi'].url = 'https://example.com/installer.msi';
    saveManifest();
    assert.throws(() => verifyArtifacts(root), /repository/);
    writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}');
    assert.throws(() => checkRelease(root), /versions differ/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('release validation rejects malformed versions and private key input', () => {
  for (const version of ['v1.0.0', '01.0.0', '1.0', '1.0.0-beta.01', '1.0.0+metadata', '1.0.0;echo']) {
    assert.throws(() => validateVersion(version));
  }
  assert.equal(validateVersion('2.1.0-beta.0'), '2.1.0-beta.0');
  assert.equal(validatePublicKey(config.plugins.updater.pubkey), config.plugins.updater.pubkey);
  assert.throws(() => validatePublicKey(Buffer.from('untrusted comment: minisign encrypted secret key\nfixture').toString('base64')), /public/);
});

test('updater key validation rejects missing padding and normalization preserves key bytes', () => {
  const publicText = Buffer.from(config.plugins.updater.pubkey, 'base64').toString('utf8').trim();
  const padded = Buffer.from(publicText).toString('base64');
  const unpadded = padded.replace(/=+$/, '');
  assert.notEqual(padded, unpadded);
  assert.throws(() => validatePublicKey(unpadded), /padding/);
  assert.equal(normalizePublicKey(unpadded), padded);
  assert.deepEqual(Buffer.from(normalizePublicKey(unpadded), 'base64'), Buffer.from(unpadded, 'base64'));
  for (const invalid of ['A', padded + '=', padded.replace(/.$/, '!'), Buffer.from('private key fixture').toString('base64')]) {
    assert.throws(() => normalizePublicKey(invalid));
  }
  const root = mkdtempSync(join(tmpdir(), 'p2sharer-public-key-'));
  try {
    mkdirSync(join(root, 'src-tauri'));
    const path = join(root, 'src-tauri/tauri.conf.json');
    const legacy = structuredClone(config);
    legacy.plugins.updater.pubkey = unpadded;
    writeFileSync(path, JSON.stringify(legacy));
    normalizeConfiguredPublicKey(root);
    const normalized = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(normalized.plugins.updater.pubkey, padded);
    normalized.plugins.updater.pubkey = unpadded;
    assert.deepEqual(normalized, legacy);
    const before = readFileSync(path, 'utf8');
    normalizeConfiguredPublicKey(root);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
