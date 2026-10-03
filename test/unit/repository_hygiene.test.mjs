import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspectEntry, inspectNetworkIdentifiers } from '../../tools/repository-hygiene.mjs';

const inspect = (path, text = '') => inspectEntry(path, Buffer.from(text));

describe('Public repository hygiene', () => {
  it('rejects nested private environments and forgotten diagnostics', () => {
    for (const path of ['fixtures/.env.production', 'deploy/turn/config.yaml', 'logs.txt', 'report.log', 'src-tauri/target/release/app.exe', 'DEBUG_PERFORMANCE_PC_AMIGO.md']) {
      assert.ok(inspect(path).length, path);
    }
  });
  it('preserves environment templates, source licenses, lockfiles and icons', () => {
    for (const path of ['fixtures/.env.example', 'public/fonts/LICENSE.txt', 'pnpm-lock.yaml', 'src-tauri/icons/icon.icns']) {
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
  it('flags infrastructure addresses while preserving loopback, examples and browser versions', () => {
    assert.ok(inspectNetworkIdentifiers([10, 12, 34, 56].join('.')).length);
    assert.ok(inspectNetworkIdentifiers(`"${['fd00', 'abcd', '', '42'].join(':')}"`).length);
    assert.deepEqual(inspectNetworkIdentifiers('127.0.0.1 0.0.0.0 "::1" "::" 203.0.113.10 198.51.100.1 192.0.2.1 "2001:db8::1" Chrome/130.0.0.0'), []);
  });
  it('flags credential URLs and private hosts without rejecting the public broker or Tauri host', () => {
    const credentialUrl = ['https:', '', ['user', ':', 'placeholder', '@', 'example.com'].join('')].join('/');
    assert.ok(inspectNetworkIdentifiers(credentialUrl).length);
    const privateHost = ['https:', '', ['server', 'internal'].join('.')].join('/');
    assert.ok(inspectNetworkIdentifiers(privateHost).length);
    assert.deepEqual(inspectNetworkIdentifiers('wss://public:public@public.cloud.shiftr.io https://tauri.localhost'), []);
  });
});
