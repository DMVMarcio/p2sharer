import i18next from 'i18next';
import en from './locales/en.json' with { type: 'json' };
import ptBR from './locales/pt-BR.json' with { type: 'json' };
import emojiEn from './locales/emoji-en.json' with { type: 'json' };
import emojiPtBR from './locales/emoji-pt-BR.json' with { type: 'json' };
import { APP_LANGUAGES, isAppLanguage, detectLanguage, LANGUAGE_STORAGE_KEY, normalizeLanguage, readLanguage, type AppLanguage } from './language.ts';

const dynamicCatalogs: Record<Exclude<AppLanguage, 'en' | 'pt-BR'>, () => Promise<{ default: Record<string, string> }>> = {
  es: () => import('./locales/es.json'),
  fr: () => import('./locales/fr.json'),
  de: () => import('./locales/de.json'),
  it: () => import('./locales/it.json'),
  'zh-CN': () => import('./locales/zh-CN.json'),
  'zh-TW': () => import('./locales/zh-TW.json'),
  ja: () => import('./locales/ja.json'),
  ko: () => import('./locales/ko.json'),
  hi: () => import('./locales/hi.json'),
  fi: () => import('./locales/fi.json'),
  ru: () => import('./locales/ru.json'),
};

const dynamicEmojiCatalogs: Record<Exclude<AppLanguage, 'en' | 'pt-BR'>, () => Promise<{ default: Record<string, string> }>> = {
  es: () => import('./locales/emoji-es.json'),
  fr: () => import('./locales/emoji-fr.json'),
  de: () => import('./locales/emoji-de.json'),
  it: () => import('./locales/emoji-it.json'),
  'zh-CN': () => import('./locales/emoji-zh-CN.json'),
  'zh-TW': () => import('./locales/emoji-zh-TW.json'),
  ja: () => import('./locales/emoji-ja.json'),
  ko: () => import('./locales/emoji-ko.json'),
  hi: () => import('./locales/emoji-hi.json'),
  fi: () => import('./locales/emoji-fi.json'),
  ru: () => import('./locales/emoji-ru.json'),
};

const loadedLanguages = new Set<AppLanguage>(['en', 'pt-BR']);
const pendingLoads = new Map<AppLanguage, Promise<void>>();

export const i18n = i18next.createInstance();
void i18n.init({
  resources: {
    en: { translation: { ...en, ...emojiEn } },
    'pt-BR': { translation: { ...ptBR, ...emojiPtBR } },
  },
  lng: readLanguage() ?? detectLanguage(typeof navigator === 'undefined' ? [] : navigator.languages),
  supportedLngs: [...APP_LANGUAGES], fallbackLng: 'en',
  keySeparator: false, nsSeparator: false, initAsync: false,
  interpolation: { escapeValue: false },
});

export function t(key: string, values?: Record<string, unknown>): string {
  return i18n.t(key, values as Record<string, string>) as string;
}

const exactMessages = new Map<string, string>();
const templates: Array<{ key: string; pattern: RegExp; variables: string[] }> = [];

function registerCatalogEntries(catalog: Record<string, string>): void {
  for (const [key, message] of Object.entries(catalog)) {
    exactMessages.set(message, key);
    const variables: string[] = [];
    const parts = message.split(/(\{\{v\d+\}\})/g);
    if (parts.length < 2) continue;
    const pattern = parts.map((part) => {
      if (/^\{\{v\d+\}\}$/.test(part)) { variables.push(part.slice(2, -2)); return '(.*?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    templates.push({ key, pattern: new RegExp(`^${pattern}$`, 's'), variables });
  }
  // Match a specific status before a broad template such as "{{v0}} of {{v1}}".
  templates.sort((a, b) => b.pattern.source.length - a.pattern.source.length);
}

registerCatalogEntries(en);
registerCatalogEntries(ptBR);

export async function loadLanguage(language: AppLanguage): Promise<void> {
  if (loadedLanguages.has(language)) return;
  const pending = pendingLoads.get(language);
  if (pending) return pending;
  const loader = (async () => {
    try {
      if (language in dynamicCatalogs) {
        const [catalogMod, emojiMod] = await Promise.all([
          dynamicCatalogs[language as keyof typeof dynamicCatalogs](),
          dynamicEmojiCatalogs[language as keyof typeof dynamicEmojiCatalogs](),
        ]);
        const catalog = catalogMod.default;
        const emoji = emojiMod.default;
        i18n.addResourceBundle(language, 'translation', { ...catalog, ...emoji }, true, true);
        registerCatalogEntries(catalog);
        loadedLanguages.add(language);
      }
    } finally {
      pendingLoads.delete(language);
    }
  })();
  pendingLoads.set(language, loader);
  return loader;
}

/** Present known app statuses/errors saved before a language change. Never use
 * this on names, chat bodies, shared documents or other user-authored content. */
export function localizeText(message: string): string {
  const key = exactMessages.get(message);
  if (key) return t(key);
  for (const template of templates) {
    const match = template.pattern.exec(message);
    if (match) return t(template.key, Object.fromEntries(template.variables.map((name, index) => [name, match[index + 1]])));
  }
  return message;
}

export function getLanguage(): AppLanguage { return isAppLanguage(i18n.language) ? i18n.language : 'en'; }

function applyLanguageSync(language: AppLanguage): void {
  void i18n.changeLanguage(language);
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}

export function setLanguage(language: AppLanguage): Promise<void> | void {
  if (!isAppLanguage(language)) return;
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch { /* Session-only when storage is unavailable. */ }
  if (loadedLanguages.has(language)) {
    applyLanguageSync(language);
    return;
  }
  return loadLanguage(language).then(() => {
    applyLanguageSync(language);
  });
}

let initialization: Promise<void> | undefined;
export function initializeLanguage(): Promise<void> {
  return initialization ??= initialize();
}

/** Keep raw native diagnostics in logs; the interface always has localized copy. */
export function localizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (exactMessages.has(message) || templates.some((template) => template.pattern.test(message))) return localizeText(message);
  return t('error.unknown');
}

async function initialize(): Promise<void> {
  let language = readLanguage();
  if (!language) {
    language = detectLanguage(typeof navigator === 'undefined' ? [] : navigator.languages);
    const { invoke, isTauri } = await import('@tauri-apps/api/core');
    if (isTauri()) {
      try { language = normalizeLanguage(await invoke<string>('get_system_locale')) ?? 'en'; }
      catch (error) { console.warn('[Language] OS locale unavailable:', error); }
    }
    await setLanguage(language);
  } else await setLanguage(language);
  if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
    if (event.key === LANGUAGE_STORAGE_KEY) void setLanguage(readLanguage() ?? 'en');
  });
}
