// Packages the release executable as an unsigned MSIX for Microsoft Store submission.
// The Store signs the package during certification; local tests register the loose layout.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRelease } from './release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = join(root, 'src-tauri');
const releaseDir = join(tauriDir, 'target', 'release');
const msixDir = join(tauriDir, 'windows', 'msix');
const layout = join(releaseDir, 'msix', 'layout');
const outputDir = join(releaseDir, 'bundle', 'msix');

// MSIX resource qualifiers for every supported application language.
const LANGUAGES = ['en-US', 'pt-BR', 'es', 'fr', 'de', 'it', 'zh-CN', 'zh-TW', 'ja', 'ko', 'hi', 'fi', 'ru'];
const ASSETS = ['StoreLogo.png', 'Square44x44Logo.png', 'Square71x71Logo.png', 'Square150x150Logo.png'];
const LOCAL_IDENTITY = { identityName: 'P2Sharer.LocalTest', publisher: 'CN=P2Sharer Local Test', publisherDisplayName: 'P2Sharer (local test)' };

/** Store versions use four numeric parts; prerelease builds are not published to the Store. */
export function msixVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`MSIX packages require a stable version, received ${version}.`);
  if (match.slice(1).some(part => Number(part) > 65535)) throw new Error('MSIX version parts must not exceed 65535.');
  return `${match[1]}.${match[2]}.${match[3]}.0`;
}

export function storeIdentity(config, local) {
  if (local) return LOCAL_IDENTITY;
  const placeholder = Object.values(config).some(value => typeof value !== 'string' || value.includes('REPLACE_WITH'));
  if (placeholder) {
    throw new Error('Fill src-tauri/windows/msix/store.json with the Package/Identity values from Partner Center (Product identity page), or pass --local for a local test layout.');
  }
  if (!config.publisher.startsWith('CN=')) throw new Error('Publisher must be the full Partner Center value starting with CN=.');
  return config;
}

const escapeXml = value => value.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);

export function renderManifest(template, identity, version) {
  return template
    .replaceAll('{{IDENTITY_NAME}}', escapeXml(identity.identityName))
    .replaceAll('{{PUBLISHER}}', escapeXml(identity.publisher))
    .replaceAll('{{PUBLISHER_DISPLAY_NAME}}', escapeXml(identity.publisherDisplayName))
    .replaceAll('{{VERSION}}', version)
    .replaceAll('{{LANGUAGES}}', LANGUAGES.map(language => `    <Resource Language="${language}" />`).join('\n'));
}

/** Uses the newest installed Windows SDK tool for the host architecture. */
function sdkTool(name) {
  const kits = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const versions = existsSync(kits) ? readdirSync(kits).filter(entry => /^10\./.test(entry)).sort((a, b) =>
    a.split('.').map(Number).reduce((order, part, index) => order || part - Number(b.split('.')[index]), 0)).reverse() : [];
  for (const version of versions) {
    const candidate = join(kits, version, 'x64', `${name}.exe`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${name}.exe was not found. Install the Windows 10/11 SDK (App packaging tools).`);
}

function run(tool, args) {
  const result = spawnSync(tool, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${tool} exited with code ${result.status}.`);
}

function main() {
  const local = process.argv.includes('--local');
  const version = msixVersion(checkRelease());
  const identity = storeIdentity(JSON.parse(readFileSync(join(msixDir, 'store.json'), 'utf8')), local);
  const executable = join(releaseDir, 'p2sharer.exe');
  if (!existsSync(executable)) throw new Error('Build the release executable first (pnpm run tauri:build -- --no-bundle).');

  rmSync(layout, { recursive: true, force: true });
  mkdirSync(join(layout, 'Assets'), { recursive: true });
  mkdirSync(join(layout, 'resources', 'wintun'), { recursive: true });
  copyFileSync(executable, join(layout, 'p2sharer.exe'));
  copyFileSync(join(tauriDir, 'resources', 'wintun', 'LICENSE.txt'), join(layout, 'resources', 'wintun', 'LICENSE.txt'));
  for (const asset of ASSETS) copyFileSync(join(tauriDir, 'icons', asset), join(layout, 'Assets', asset));
  writeFileSync(join(layout, 'AppxManifest.xml'),
    renderManifest(readFileSync(join(msixDir, 'AppxManifest.template.xml'), 'utf8'), identity, version));

  const makepri = sdkTool('makepri');
  const priConfig = join(releaseDir, 'msix', 'priconfig.xml');
  run(makepri, ['createconfig', '/cf', priConfig, '/dq', 'en-US', '/pv', '10.0.0', '/o']);
  run(makepri, ['new', '/pr', layout, '/cf', priConfig, '/mn', join(layout, 'AppxManifest.xml'), '/of', join(layout, 'resources.pri'), '/o']);

  if (local) {
    console.log(`Local test layout ready: ${layout}`);
    console.log(`Register it (Developer Mode required): Add-AppxPackage -Register "${join(layout, 'AppxManifest.xml')}"`);
    return;
  }
  mkdirSync(outputDir, { recursive: true });
  const output = join(outputDir, `P2Sharer_${version.replace(/\.0$/, '')}_x64.msix`);
  run(sdkTool('makeappx'), ['pack', '/d', layout, '/p', output, '/o']);
  console.log(`Unsigned Store package: ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
