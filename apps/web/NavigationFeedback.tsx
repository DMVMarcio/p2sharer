import { useCallback, useSyncExternalStore } from 'react';
import type { RouterProviderProps } from 'react-router';
import { useDropdownPresence } from '../../src/hooks/useDropdownPresence';
import { useLocale } from '../../src/hooks/useLocale';
import { t } from '../../src/i18n';

/** Subscribe outside RouterProvider so pending feedback is an urgent React update. */
export function NavigationFeedback({ router }: Pick<RouterProviderProps, 'router'>) {
  const subscribe = useCallback((notify: () => void) => router.subscribe(notify), [router]);
  const snapshot = useCallback(() => !router.state.initialized || router.state.navigation.state !== 'idle', [router]);
  const busy = useSyncExternalStore(subscribe, snapshot);
  const presence = useDropdownPresence(busy ? true : null);
  useLocale();
  if (!presence.value) return null;
  const label = t('message.e9be847e98aa');
  return <div className={`site-route-loading${presence.closing ? ' closing' : ''}`} inert={presence.closing || undefined} aria-hidden={presence.closing || undefined}>
    <div className="site-route-progress" role="progressbar" aria-label={label} />
    <div className="site-route-loading-label" role="status"><span className="loading-spinner" aria-hidden="true" />{label}</div>
  </div>;
}
