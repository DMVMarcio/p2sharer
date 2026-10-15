import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installerOutputLine, normalizeInstallerNames } from '../../tools/installer-names.mjs';

test('artifact summaries report the canonical MSI name without collecting ordinary log lines', () => {
  const artifacts = new Set();
  const source = join(tmpdir(), 'workspace with spaces', 'P2Sharer_1.3.6_x64_en-US.msi');
  const summary = `        ${source} (19.14 MiB)`;
  assert.equal(installerOutputLine(summary, artifacts), summary.replace('_en-US.msi', '-setup.msi'));
  assert.deepEqual([...artifacts], [source]);
  artifacts.clear();
  const log = `Running light to produce ${source}`;
  assert.equal(installerOutputLine(log, artifacts), log);
  assert.equal(installerOutputLine('P2Sharer_1.3.6_x64-setup.exe', artifacts), 'P2Sharer_1.3.6_x64-setup.exe');
  assert.equal(artifacts.size, 0);
});

test('unsigned builds replace the canonical MSI and discard an obsolete signature', () => {
  const root = mkdtempSync(join(tmpdir(), 'p2sharer-installer-'));
  try {
    const source = join(root, 'P2Sharer_1.3.6_x64_en-US.msi');
    const destination = source.replace('_en-US.msi', '-setup.msi');
    writeFileSync(source, 'current installer');
    writeFileSync(destination, 'previous installer');
    writeFileSync(`${destination}.sig`, 'obsolete signature');
    writeFileSync(`${source}.sig`, 'obsolete bundler signature');
    utimesSync(`${source}.sig`, new Date(0), new Date(0));
    normalizeInstallerNames([source], root);
    assert.equal(readFileSync(destination, 'utf8'), 'current installer');
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(`${destination}.sig`), false);
    assert.equal(existsSync(`${source}.sig`), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('signed MSI renaming preserves installer and signature bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'p2sharer-installer-'));
  try {
    const source = join(root, 'P2Sharer_1.3.6_arm64_en-US.msi');
    const destination = source.replace('_en-US.msi', '-setup.msi');
    writeFileSync(source, 'signed installer fixture');
    writeFileSync(`${source}.sig`, 'signature fixture');
    normalizeInstallerNames([source], root);
    assert.equal(readFileSync(destination, 'utf8'), 'signed installer fixture');
    assert.equal(readFileSync(`${destination}.sig`, 'utf8'), 'signature fixture');
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(`${source}.sig`), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('normalization rejects artifacts outside the canonical target directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'p2sharer-installer-'));
  try {
    const outside = join(root, 'P2Sharer_1.3.6_x64_en-US.msi');
    writeFileSync(outside, 'untouched');
    assert.throws(() => normalizeInstallerNames([outside], join(root, 'target')), /outside/);
    assert.equal(readFileSync(outside, 'utf8'), 'untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
