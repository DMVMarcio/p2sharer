import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkRelease, validateVersion } from './release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const languages = ['en', 'pt-BR', 'es', 'fr', 'de', 'it', 'zh-CN', 'zh-TW', 'ja', 'ko', 'hi', 'fi', 'ru'];

export function checkReleaseNotes(directory = root) {
  const version = checkRelease(directory);
  const notes = JSON.parse(readFileSync(resolve(directory, 'src/releases/current.json'), 'utf8'));
  if (notes.version !== version) throw new Error('Release notes version differs. Run pnpm run release:notes and complete the notes.');
  for (const language of languages) {
    const items = notes.translations?.[language];
    if (!Array.isArray(items) || items.length === 0 || items.some(item => typeof item !== 'string' || !item.trim())) {
      throw new Error(`Complete release notes for ${language} in src/releases/current.json.`);
    }
  }
  return notes;
}

export function prepareReleaseNotes(directory = root) {
  const version = checkRelease(directory);
  const path = resolve(directory, 'src/releases/current.json');
  if (existsSync(path)) {
    const previous = JSON.parse(readFileSync(path, 'utf8'));
    if (previous.version === version) return path;
    const archive = resolve(directory, 'docs/release-notes');
    mkdirSync(archive, { recursive: true });
    const destination = resolve(archive, `${validateVersion(previous.version)}.json`);
    // Never overwrite an existing archived release.
    writeFileSync(destination, JSON.stringify(previous, null, 2) + '\n', { flag: 'wx' });
  }
  writeFileSync(path, JSON.stringify({ version, translations: Object.fromEntries(languages.map(language => [language, []])) }, null, 2) + '\n');
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: release-notes.mjs [prepare|check]');
    const command = process.argv[2] ?? 'prepare';
    if (command === 'prepare') console.log(`Edit release notes: ${prepareReleaseNotes()}`);
    else if (command === 'check') console.log(`Release notes verified: ${checkReleaseNotes().version}`);
    else throw new Error('Usage: release-notes.mjs [prepare|check]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
