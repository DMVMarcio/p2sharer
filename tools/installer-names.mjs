import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function installerOutputLine(line, artifacts) {
  const match = stripVTControlCharacters(line).match(/^\s*((?:[A-Za-z]:[\\/]|\/).+_en-US\.msi)(?:\s+\([^)]*\))?\s*$/);
  if (!match) return line;
  const source = match[1];
  artifacts.add(source);
  return line.replace(source, source.replace(/_en-US\.msi$/, '-setup.msi'));
}

export function normalizeInstallerNames(artifacts, targetRoot) {
  for (const source of artifacts) {
    const withinTarget = relative(resolve(targetRoot), resolve(source));
    if (!withinTarget || withinTarget.startsWith('..') || isAbsolute(withinTarget) || !source.endsWith('_en-US.msi')) {
      throw new Error('Installer output is outside the canonical Cargo target directory.');
    }
    const destination = source.replace(/_en-US\.msi$/, '-setup.msi');
    const freshSignature = existsSync(`${source}.sig`) && statSync(`${source}.sig`).mtimeMs >= statSync(source).mtimeMs;
    renameSync(source, destination);
    if (freshSignature) renameSync(`${source}.sig`, `${destination}.sig`);
    else {
      if (existsSync(`${source}.sig`)) unlinkSync(`${source}.sig`);
      if (existsSync(`${destination}.sig`)) unlinkSync(`${destination}.sig`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: installer-names.mjs <generated-msi>');
    normalizeInstallerNames([resolve(process.argv[2])], fileURLToPath(new URL('../src-tauri/target/', import.meta.url)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
