import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const numeric = '(0|[1-9]\\d*)';
const versionPattern = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`);
export function validateVersion(version) {
  const match = versionPattern.exec(version);
  if (!match || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) {
    throw new Error('Use a semantic version such as 1.0.1 or 1.1.0-beta.1, without a v prefix or build metadata.');
  }
  return version;
}
function readVersions(directory) {
  const json = name => JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
  const cargo = readFileSync(resolve(directory, 'src-tauri/Cargo.toml'), 'utf8');
  const lock = readFileSync(resolve(directory, 'src-tauri/Cargo.lock'), 'utf8');
  const manifestMatch = /\[package\][\s\S]*?^version = "([^"]+)"/m.exec(cargo);
  const lockMatch = /\[\[package\]\]\r?\nname = "p2sharer"\r?\nversion = "([^"]+)"/.exec(lock);
  if (!manifestMatch || !lockMatch) throw new Error('Cannot locate the application version in Cargo files.');
  return { packageJson: json('package.json'), config: json('src-tauri/tauri.conf.json'), cargo, lock,
    manifestMatch, lockMatch };
}
export function checkRelease(directory = root, tag) {
  const files = readVersions(directory);
  const version = validateVersion(files.config.version);
  if ([files.packageJson.version, files.manifestMatch[1], files.lockMatch[1]].some(value => value !== version)) {
    throw new Error('Application versions differ. Run pnpm run release:version <version>.');
  }
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`Release tag must be v${version}.`);
  if (files.config.identifier.endsWith('.app')) throw new Error('Bundle identifier must not end in .app.');
  validatePublicKey(files.config.plugins?.updater?.pubkey);
  return version;
}
export function setVersion(version, directory = root) {
  validateVersion(version);
  const files = readVersions(directory);
  files.packageJson.version = version;
  files.config.version = version;
  // Parse all inputs before modifying any file. Preserve dependency versions.
  const cargo = files.cargo.replace(files.manifestMatch[0], files.manifestMatch[0].replace(
    `version = "${files.manifestMatch[1]}"`, `version = "${version}"`));
  const lock = files.lock.replace(files.lockMatch[0], files.lockMatch[0].replace(
    `version = "${files.lockMatch[1]}"`, `version = "${version}"`));
  writeFileSync(resolve(directory, 'package.json'), JSON.stringify(files.packageJson, null, 2) + '\n');
  writeFileSync(resolve(directory, 'src-tauri/tauri.conf.json'), JSON.stringify(files.config, null, 2) + '\n');
  writeFileSync(resolve(directory, 'src-tauri/Cargo.toml'), cargo);
  writeFileSync(resolve(directory, 'src-tauri/Cargo.lock'), lock);
}
export function validatePublicKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim())) throw new Error('A Tauri public updater key is required.');
  if (Buffer.from(value.trim(), 'base64').toString('base64') !== value.trim()) {
    throw new Error('Public updater key must use canonical Base64 with valid padding.');
  }
  const decoded = Buffer.from(value.trim(), 'base64').toString('utf8');
  const lines = decoded.trim().split(/\r?\n/);
  const raw = Buffer.from(lines[1] || '', 'base64');
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment: minisign public key:') || raw.length !== 42 ||
      raw.toString('base64') !== lines[1] || raw.subarray(0, 2).toString() !== 'Ed') {
    throw new Error('Expected a public .key.pub file, never a private signing key.');
  }
  return value.trim();
}

export function normalizePublicKey(value) {
  if (typeof value !== 'string') return validatePublicKey(value);
  const trimmed = value.trim();
  // Repair encoding only; validation still rejects malformed or private key data.
  return validatePublicKey(trimmed.padEnd(Math.ceil(trimmed.length / 4) * 4, '='));
}

export function normalizeConfiguredPublicKey(directory = root) {
  const path = resolve(directory, 'src-tauri/tauri.conf.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const original = config.plugins?.updater?.pubkey;
  const normalized = normalizePublicKey(original);
  if (normalized !== original) {
    config.plugins.updater.pubkey = normalized;
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  }
  return normalized;
}

export function verifyArtifacts(directory = root) {
  const version = checkRelease(directory);
  const manifest = JSON.parse(readFileSync(resolve(directory, 'latest.json'), 'utf8'));
  if (manifest.version !== version) throw new Error('Updater manifest version does not match the application.');
  const config = JSON.parse(readFileSync(resolve(directory, 'src-tauri/tauri.conf.json'), 'utf8'));
  const publicLines = Buffer.from(config.plugins.updater.pubkey, 'base64').toString('utf8').trim().split(/\r?\n/);
  const keyId = Buffer.from(publicLines[1], 'base64').subarray(2, 10);
  for (const type of ['nsis', 'msi']) {
    const entry = manifest.platforms?.[`windows-x86_64-${type}`];
    if (!entry?.signature || !entry?.url) throw new Error(`Missing signed Windows ${type} updater entry.`);
    const url = new URL(entry.url);
    if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' ||
      !/^\/repos\/DMVMarcio\/p2sharer\/releases\/assets\/\d+$/.test(url.pathname)) {
      throw new Error('Updater asset must belong to this GitHub release repository.');
    }
    const lines = Buffer.from(entry.signature.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
    const signature = Buffer.from(lines[1] || '', 'base64');
    if (signature.length !== 74 || !signature.subarray(2, 10).equals(keyId)) {
      throw new Error('Updater signing key does not match the application public key.');
    }
  }
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'version' && args.length === 1) {
      setVersion(args[0]);
      console.log(`Application version set to ${args[0]}. Review and commit before creating a release tag.`);
    } else if (command === 'key' && args.length === 1) {
      const key = validatePublicKey(readFileSync(resolve(args[0]), 'utf8'));
      const path = resolve(root, 'src-tauri/tauri.conf.json');
      const config = JSON.parse(readFileSync(path, 'utf8'));
      config.plugins.updater.pubkey = key;
      writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
      console.log('Public updater key configured. Never replace the key for distributed builds without a migration plan.');
    } else if (command === 'normalize-key' && args.length === 1) {
      normalizeConfiguredPublicKey(resolve(args[0]));
      console.log('Public updater key encoding validated; cryptographic key unchanged.');
    } else if (command === 'artifacts' && args.length === 0) {
      console.log(`Signed updater manifest verified: ${verifyArtifacts()}`);
    } else if (command === 'check' && (args.length === 0 ||
      (args.length === 1 && args[0] === '--signing') ||
      ((args.length === 2 || (args.length === 3 && args[2] === '--signing')) && args[0] === '--tag'))) {
      if (args.includes('--signing') && !(process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH)) {
        throw new Error('Set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH for a signed release build.');
      }
      console.log(`Release version verified: ${checkRelease(root, args[0] === '--tag' ? args[1] : undefined)}`);
    } else throw new Error('Usage: release.mjs version <version> | check [--tag vX.Y.Z] [--signing] | key <public-key-file> | normalize-key <directory> | artifacts');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
