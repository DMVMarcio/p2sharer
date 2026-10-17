import { configureNativeBuildEnvironment } from './native-build-env.mjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { installerOutputLine, normalizeInstallerNames } from './installer-names.mjs';
import { pruneInstallerArtifacts } from './installer-cleanup.mjs';
import { checkRelease } from './release.mjs';

configureNativeBuildEnvironment();

const args = process.argv.slice(2);
if (process.platform === 'win32' && ['build', 'bundle'].includes(args[0]) && process.env.P2SHARER_TAURI_ACTION !== '1') {
  // Preserve the CLI's artifact summary for release tooling, using the same
  // names on disk and in its output, including matching updater signatures.
  const artifacts = new Set();
  const require = createRequire(import.meta.url);
  const child = spawn(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), ...args],
    { stdio: ['inherit', 'pipe', 'pipe'] });
  for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    createInterface({ input, crlfDelay: Infinity }).on('line', line => {
      output.write(`${installerOutputLine(line, artifacts)}\n`);
    });
  }
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code ?? 1));
    });
    if (code === 0) {
      const target = fileURLToPath(new URL('../src-tauri/target/', import.meta.url));
      normalizeInstallerNames(artifacts, target);
      const removed = pruneInstallerArtifacts(target, checkRelease(), args.includes('--debug') ? 'debug' : 'release');
      if (removed.length) console.log(`Removed ${removed.length} superseded local bundle files.`);
    }
    process.exitCode = code;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
} else {
  // Development and other commands retain the installed CLI's interactive IO.
  await import('@tauri-apps/cli/tauri.js');
}
