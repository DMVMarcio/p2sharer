export const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'pt-BR', label: 'Português Brasil' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'it', label: 'Italiano' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'fi', label: 'Suomi' },
  { value: 'ru', label: 'Русский' },
] as const;
export type AppLanguage = typeof LANGUAGE_OPTIONS[number]['value'];
export const APP_LANGUAGES: readonly AppLanguage[] = LANGUAGE_OPTIONS.map(option => option.value);
export const LANGUAGE_STORAGE_KEY = 'p2sharer_language';

export function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === 'string' && APP_LANGUAGES.includes(value as AppLanguage);
}

export function normalizeLanguage(value: unknown): AppLanguage | null {
  if (typeof value !== 'string') return null;
  const [primary, ...subtags] = value.toLowerCase().replace(/_/g, '-').split('-');
  if (primary === 'pt') return 'pt-BR';
  if (primary === 'zh') {
    if (subtags.includes('hant')) return 'zh-TW';
    if (subtags.includes('hans')) return 'zh-CN';
    return subtags.some(tag => ['tw', 'hk', 'mo'].includes(tag)) ? 'zh-TW' : 'zh-CN';
  }
  return isAppLanguage(primary) ? primary : null;
}

export function detectLanguage(languages: readonly string[]): AppLanguage {
  // The primary OS language determines the first-run UI, even if an unsupported
  // primary language has a supported secondary language preference.
  return normalizeLanguage(languages[0]) ?? 'en';
}

export function readLanguage(): AppLanguage | null {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isAppLanguage(saved) ? saved : null;
  } catch { return null; }
}
