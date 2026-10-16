import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkRelease } from './release.mjs';

export const portableMarker = Buffer.from('\nP2SHARER_PORTABLE_V1\n');

export function createPortable(directory) {
  const version = checkRelease(directory);
  const binary = readFileSync(resolve(directory, 'src-tauri/target/release/p2sharer.exe'));
  if (binary.subarray(0, 2).toString() !== 'MZ') throw new Error('Expected a Windows executable');
  const destination = resolve(directory, `src-tauri/target/release/bundle/portable/P2Sharer_${version}_x64-portable.exe`);
  mkdirSync(resolve(destination, '..'), { recursive: true });
  writeFileSync(destination, binary.subarray(-portableMarker.length).equals(portableMarker)
    ? binary : Buffer.concat([binary, portableMarker]));
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const directory = process.cwd();
    const destination = createPortable(directory);
    if (process.argv.includes('--sign')) {
      const result = spawnSync(process.execPath, ['tools/tauri.mjs', 'signer', 'sign', '--app-version', checkRelease(directory), destination],
        { cwd: directory, stdio: 'inherit' });
      if (result.error || result.status !== 0) throw result.error ?? new Error('Portable signing failed');
    }
    console.log(`Portable executable: ${destination}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
