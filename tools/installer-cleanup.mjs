import { existsSync, lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkRelease, validateVersion } from './release.mjs';

/** Remove only recognized superseded bundles with a current equivalent. Never recurse. */
export function pruneInstallerArtifacts(targetRoot, version, profile = 'release') {
  validateVersion(version);
  if (!['release', 'debug'].includes(profile)) throw new Error('Unsupported build profile');
  if (lstatSync(targetRoot).isSymbolicLink()) throw new Error('Cargo target must not be a symbolic link');
  const root = realpathSync(targetRoot);
  const removed = [];
  for (const [folder, suffix] of [['msi', '(?:-setup|_en-US)\\.msi'], ['nsis', '-setup\\.exe'], ['portable', '-portable\\.exe']]) {
    const directory = resolve(root, profile, 'bundle', folder);
    if (!existsSync(directory)) continue;
    const within = relative(root, realpathSync(directory));
    if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('Bundle directory escapes the Cargo target');
    const pattern = new RegExp(`^P2Sharer_(.+)_(x64|x86|arm64)(${suffix})(\\.sig)?$`);
    const entries = readdirSync(directory);
    for (const name of entries) {
      const match = pattern.exec(name);
      if (!match || match[1] === version) continue;
      try { validateVersion(match[1]); } catch { continue; }
      const equivalent = `P2Sharer_${version}_${match[2]}${match[3]}`;
      // MSI normalization can change a legacy suffix without changing its format.
      const current = resolve(directory, folder === 'msi' ? equivalent.replace('_en-US.msi', '-setup.msi') : equivalent);
      if (!existsSync(current) || !lstatSync(current).isFile() || lstatSync(current).isSymbolicLink()) continue;
      const candidate = resolve(directory, name);
      const stat = lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      unlinkSync(candidate);
      removed.push(candidate);
    }
  }
  return removed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: installer-cleanup.mjs');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const removed = pruneInstallerArtifacts(resolve(root, 'src-tauri/target'), checkRelease(root));
    console.log(`Removed ${removed.length} superseded local bundle files.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
