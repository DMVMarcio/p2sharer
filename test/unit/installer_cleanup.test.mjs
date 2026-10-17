import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneInstallerArtifacts } from '../../tools/installer-cleanup.mjs';

test('cleanup removes superseded installers and signatures only when a matching current bundle exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'p2sharer-cleanup-'));
  const put = (folder, name) => {
    const dir = join(root, 'release/bundle', folder);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, 'fixture');
    return file;
  };
  try {
    const obsolete = [put('msi', 'P2Sharer_1.0.0_x64_en-US.msi'), put('msi', 'P2Sharer_1.0.0_x64_en-US.msi.sig'),
      put('nsis', 'P2Sharer_1.4.0_x64-setup.exe'), put('nsis', 'P2Sharer_1.4.0_x64-setup.exe.sig')];
    const retained = [put('msi', 'P2Sharer_1.4.1_x64-setup.msi'), put('msi', 'P2Sharer_1.4.1_x64-setup.msi.sig'),
      put('nsis', 'P2Sharer_1.4.1_x64-setup.exe'), put('nsis', 'P2Sharer_1.4.0_arm64-setup.exe'),
      put('portable', 'P2Sharer_1.4.0_x64-portable.exe'), put('nsis', 'Unrelated_1.4.0_x64-setup.exe'),
      put('nsis', 'P2Sharer_custom_x64-setup.exe'), put('nsis', 'keep.txt')];
    assert.deepEqual(new Set(pruneInstallerArtifacts(root, '1.4.1')), new Set(obsolete));
    for (const file of obsolete) assert.equal(existsSync(file), false);
    for (const file of retained) assert.equal(existsSync(file), true);
    assert.deepEqual(pruneInstallerArtifacts(root, '1.4.1'), []);
    put('portable', 'P2Sharer_1.4.1_x64-portable.exe');
    assert.deepEqual(pruneInstallerArtifacts(root, '1.4.1'), [retained[4]]);
    assert.throws(() => pruneInstallerArtifacts(root, '../invalid'), /version/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cleanup rejects bundle directories redirected outside the target', () => {
  const root = mkdtempSync(join(tmpdir(), 'p2sharer-cleanup-'));
  const outside = mkdtempSync(join(tmpdir(), 'p2sharer-outside-'));
  try {
    mkdirSync(join(root, 'release/bundle'), { recursive: true });
    writeFileSync(join(outside, 'P2Sharer_1.4.0_x64-setup.exe'), 'untouched');
    writeFileSync(join(outside, 'P2Sharer_1.4.1_x64-setup.exe'), 'untouched');
    symlinkSync(outside, join(root, 'release/bundle/nsis'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => pruneInstallerArtifacts(root, '1.4.1'), /escapes/);
    assert.equal(existsSync(join(outside, 'P2Sharer_1.4.0_x64-setup.exe')), true);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
