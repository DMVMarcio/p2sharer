import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setVersion } from '../../tools/release.mjs';
import { checkReleaseNotes, prepareReleaseNotes } from '../../tools/release-notes.mjs';

test('notes preparation preserves the current release, archives it for the next version and rejects incomplete translations', () => {
  const root = mkdtempSync(join(tmpdir(), 'p2sharer-notes-'));
  try {
    for (const name of ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src/releases/current.json']) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      copyFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), join(root, name));
    }
    const path = join(root, 'src/releases/current.json');
    const current = readFileSync(path, 'utf8');
    const currentVersion = checkReleaseNotes(root).version;
    assert.equal(prepareReleaseNotes(root), path);
    assert.equal(readFileSync(path, 'utf8'), current);
    const next = currentVersion === '9.9.9' ? '9.9.10' : '9.9.9';
    setVersion(next, root);
    assert.throws(() => checkReleaseNotes(root), /version differs/);
    prepareReleaseNotes(root);
    assert.deepEqual(JSON.parse(readFileSync(join(root, `docs/release-notes/${currentVersion}.json`), 'utf8')), JSON.parse(current));
    assert.throws(() => checkReleaseNotes(root), /Complete release notes/);
    const draft = JSON.parse(readFileSync(path, 'utf8'));
    for (const language of Object.keys(draft.translations)) draft.translations[language] = ['Test change'];
    writeFileSync(path, JSON.stringify(draft));
    assert.equal(checkReleaseNotes(root).version, next);
    delete draft.translations['pt-BR'];
    writeFileSync(path, JSON.stringify(draft));
    assert.throws(() => checkReleaseNotes(root), /pt-BR/);
    assert.equal(existsSync(join(root, `docs/release-notes/${next}.json`)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
