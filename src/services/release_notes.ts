import { version } from '../../package.json';
import currentNotes from '../releases/current.json';
import { compareSemver, ReleaseNotesController } from '../core/release_notes';
import type { AppLanguage } from '../i18n/language';

export interface ReleaseNotesDocument {
  version: string;
  translations: Record<string, string[]>;
}

export interface ReleaseNotesSection {
  version: string;
  items: string[];
}

const archivedModules = typeof import.meta.glob === 'function'
  ? import.meta.glob<ReleaseNotesDocument>('../../docs/release-notes/*.json', { eager: true, import: 'default' })
  : {};

const releasesByVersion = new Map<string, ReleaseNotesDocument>();
for (const doc of Object.values(archivedModules)) {
  if (doc && typeof doc.version === 'string' && doc.version && doc.translations) {
    releasesByVersion.set(doc.version, doc);
  }
}
const currentVersion = typeof currentNotes.version === 'string' && currentNotes.version ? currentNotes.version : version;
releasesByVersion.set(currentVersion, { ...(currentNotes as ReleaseNotesDocument), version: currentVersion });

const availableVersions = Array.from(releasesByVersion.keys()).sort((a, b) => compareSemver(b, a));

export const releaseNotes = new ReleaseNotesController(version, {
  getItem: key => globalThis.localStorage?.getItem(key) ?? null,
  setItem: (key, value) => globalThis.localStorage?.setItem(key, value),
}, availableVersions);

export function installedReleaseNotes(language: AppLanguage): string[] {
  return currentNotes.translations[language];
}

export function releaseNotesSections(language: AppLanguage, targetVersions?: readonly string[]): ReleaseNotesSection[] {
  const ordered = (targetVersions && targetVersions.length > 0 ? [...targetVersions] : releaseNotes.getVisibleVersions())
    .slice()
    .sort((a, b) => compareSemver(b, a));
  const sections: ReleaseNotesSection[] = [];
  for (const entry of ordered) {
    const doc = releasesByVersion.get(entry);
    const items = doc?.translations[language];
    if (Array.isArray(items) && items.length > 0) {
      sections.push({ version: entry, items });
    }
  }
  if (sections.length === 0) {
    return [{ version: currentVersion, items: currentNotes.translations[language] }];
  }
  return sections;
}
