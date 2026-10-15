import i18next from 'i18next';
import en from './locales/en.json' with { type: 'json' };
import ptBR from './locales/pt-BR.json' with { type: 'json' };
import emojiEn from './locales/emoji-en.json' with { type: 'json' };
import emojiPtBR from './locales/emoji-pt-BR.json' with { type: 'json' };
import es from './locales/es.json' with { type: 'json' };
import emojiEs from './locales/emoji-es.json' with { type: 'json' };
import fr from './locales/fr.json' with { type: 'json' };
import emojiFr from './locales/emoji-fr.json' with { type: 'json' };
import de from './locales/de.json' with { type: 'json' };
import emojiDe from './locales/emoji-de.json' with { type: 'json' };
import it from './locales/it.json' with { type: 'json' };
import emojiIt from './locales/emoji-it.json' with { type: 'json' };
import zhCN from './locales/zh-CN.json' with { type: 'json' };
import emojiZhCN from './locales/emoji-zh-CN.json' with { type: 'json' };
import zhTW from './locales/zh-TW.json' with { type: 'json' };
import emojiZhTW from './locales/emoji-zh-TW.json' with { type: 'json' };
import ja from './locales/ja.json' with { type: 'json' };
import emojiJa from './locales/emoji-ja.json' with { type: 'json' };
import ko from './locales/ko.json' with { type: 'json' };
import emojiKo from './locales/emoji-ko.json' with { type: 'json' };
import hi from './locales/hi.json' with { type: 'json' };
import emojiHi from './locales/emoji-hi.json' with { type: 'json' };
import fi from './locales/fi.json' with { type: 'json' };
import emojiFi from './locales/emoji-fi.json' with { type: 'json' };
import ru from './locales/ru.json' with { type: 'json' };
import emojiRu from './locales/emoji-ru.json' with { type: 'json' };
import { APP_LANGUAGES, isAppLanguage, detectLanguage, LANGUAGE_STORAGE_KEY, normalizeLanguage, readLanguage, type AppLanguage } from './language.ts';

const catalogs = { en, 'pt-BR': ptBR, 'es': es, 'fr': fr, 'de': de, 'it': it, 'zh-CN': zhCN, 'zh-TW': zhTW, 'ja': ja, 'ko': ko, 'hi': hi, 'fi': fi, 'ru': ru };
const emojiCatalogs = { en: emojiEn, 'pt-BR': emojiPtBR, 'es': emojiEs, 'fr': emojiFr, 'de': emojiDe, 'it': emojiIt, 'zh-CN': emojiZhCN, 'zh-TW': emojiZhTW, 'ja': emojiJa, 'ko': emojiKo, 'hi': emojiHi, 'fi': emojiFi, 'ru': emojiRu };

export const i18n = i18next.createInstance();
void i18n.init({
  resources: Object.fromEntries(APP_LANGUAGES.map(language => [language, { translation: { ...catalogs[language], ...emojiCatalogs[language] } }])),
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
for (const catalog of Object.values(catalogs)) for (const [key, message] of Object.entries(catalog)) {
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

function applyLanguage(language: AppLanguage): void {
  void i18n.changeLanguage(language);
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}

export function setLanguage(language: AppLanguage): void {
  if (!isAppLanguage(language)) return;
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch { /* Session-only when storage is unavailable. */ }
  applyLanguage(language);
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
    setLanguage(language);
  } else applyLanguage(language);
  if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
    if (event.key === LANGUAGE_STORAGE_KEY) applyLanguage(readLanguage() ?? 'en');
  });
}
