import { useSyncExternalStore } from 'react';
import { getLanguage, i18n } from '../i18n/index.ts';

const subscribe = (listener: () => void) => {
  i18n.on('languageChanged', listener);
  return () => { i18n.off('languageChanged', listener); };
};

/** Subscribe each localized surface without remounting media or editor state. */
export function useLocale() {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}
