import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { configureNativeBuildEnvironment } from './native-build-env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const native = args[0] === '--native';
if (native) {
  args.shift();
  if (process.platform !== 'win32') {
    console.error('Native tests require Windows, the supported desktop platform.');
    process.exit(1);
  }
  configureNativeBuildEnvironment();
}
const files = native ? [] : readdirSync(new URL('../test/unit/', import.meta.url))
  .filter(name => /\.test\.(ts|mjs)$/.test(name)).sort().map(name => `test/unit/${name}`);
const result = spawnSync(native ? 'cargo' : process.execPath,
  // Cargo also rebuilds the application binary for integration tests. Keep it
  // in packaged mode so release tests cannot replace it with a dev-server client.
  native ? ['test', '--lib', '--tests', '--features', 'tauri/custom-protocol', ...args]
    : ['--experimental-strip-types', '--import', './test/support/locale.mjs', '--test', ...args, ...files],
  { cwd: native ? fileURLToPath(new URL('../src-tauri/', import.meta.url)) : root, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
