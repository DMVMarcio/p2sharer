export type AppLanguage = 'en' | 'pt-BR';
export const LANGUAGE_STORAGE_KEY = 'p2sharer_language';

export function normalizeLanguage(value: unknown): AppLanguage | null {
  if (typeof value !== 'string') return null;
  if (/^pt(?:[-_]|$)/i.test(value)) return 'pt-BR';
  if (/^en(?:[-_]|$)/i.test(value)) return 'en';
  return null;
}

export function detectLanguage(languages: readonly string[]): AppLanguage {
  // The primary OS language determines the first-run UI, even if an unsupported
  // primary language has Portuguese among its secondary language preferences.
  return normalizeLanguage(languages[0]) ?? 'en';
}

export function readLanguage(): AppLanguage | null {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return saved === 'en' || saved === 'pt-BR' ? saved : null;
  } catch { return null; }
}
