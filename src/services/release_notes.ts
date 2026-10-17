import { version } from '../../package.json';
import notes from '../releases/current.json';
import { ReleaseNotesController } from '../core/release_notes';
import type { AppLanguage } from '../i18n/language';

export const releaseNotes = new ReleaseNotesController(version, {
  getItem: key => globalThis.localStorage?.getItem(key) ?? null,
  setItem: (key, value) => globalThis.localStorage?.setItem(key, value),
});

export function installedReleaseNotes(language: AppLanguage): string[] {
  return notes.translations[language];
}
