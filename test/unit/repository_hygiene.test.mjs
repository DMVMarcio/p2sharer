import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspectEntry } from '../../tools/repository-hygiene.mjs';

const inspect = (path, text = '') => inspectEntry(path, Buffer.from(text));

describe('Public repository hygiene', () => {
  it('rejects nested private environments and forgotten diagnostics', () => {
    for (const path of ['deploy/turn/.env.production', 'logs.txt', 'report.log', 'src-tauri/target/release/app.exe', 'DEBUG_PERFORMANCE_PC_AMIGO.md']) {
      assert.ok(inspect(path).length, path);
    }
  });
  it('preserves environment templates, source licenses, lockfiles and icons', () => {
    for (const path of ['deploy/turn/.env.example', 'public/fonts/LICENSE.txt', 'pnpm-lock.yaml', 'src-tauri/icons/icon.icns']) {
      assert.deepEqual(inspect(path), [], path);
    }
  });
  it('detects private home paths without treating React HomeView imports as paths', () => {
    const windowsPath = ['C:', 'Users', 'private-user', 'Desktop', 'report'].join('\\');
    const linuxPath = ['', 'home', 'private-user', 'report'].join('/');
    assert.ok(inspect('note.md', windowsPath).length);
    assert.ok(inspect('note.md', linuxPath).length);
    assert.deepEqual(inspect('src/App.tsx', "import { HomeView } from './components/home/HomeView';"), []);
  });
  it('rejects oversized files and private key material', () => {
    assert.ok(inspectEntry('asset.bin', Buffer.alloc(5 * 1024 * 1024 + 1)).length);
    const header = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    assert.ok(inspect('credential.txt', header).length);
  });
});
