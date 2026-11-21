import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { msixVersion, renderManifest, storeIdentity } from '../../tools/msix.mjs';

test('Store packages use four-part stable versions and reject prereleases', () => {
  assert.equal(msixVersion('1.7.3'), '1.7.3.0');
  assert.throws(() => msixVersion('1.8.0-beta.1'), /stable version/);
  assert.throws(() => msixVersion('1.70000.0'), /65535/);
});

test('Store identity must come from Partner Center unless building a local test layout', () => {
  const placeholder = JSON.parse(readFileSync(new URL('../../src-tauri/windows/msix/store.json', import.meta.url), 'utf8'));
  assert.throws(() => storeIdentity(placeholder, false), /Partner Center/);
  assert.throws(() => storeIdentity({ identityName: 'A.B', publisher: 'Someone', publisherDisplayName: 'A' }, false), /CN=/);
  assert.equal(storeIdentity(placeholder, true).identityName, 'P2Sharer.LocalTest');
});

test('rendered manifest carries identity, version, protocol and every app language', () => {
  const template = readFileSync(new URL('../../src-tauri/windows/msix/AppxManifest.template.xml', import.meta.url), 'utf8');
  const manifest = renderManifest(template, { identityName: 'Pub.P2Sharer', publisher: 'CN=ABC & Co', publisherDisplayName: 'P2Sharer' }, '1.7.3.0');
  assert.doesNotMatch(manifest, /\{\{/);
  assert.match(manifest, /Name="Pub\.P2Sharer"/);
  assert.match(manifest, /Publisher="CN=ABC &amp; Co"/);
  assert.match(manifest, /Version="1\.7\.3\.0"/);
  assert.match(manifest, /<uap:Protocol Name="p2sharer">/);
  assert.equal(manifest.match(/<Resource Language=/g).length, 13);
});
