import { useSyncExternalStore } from 'react';
import { appUpdates } from '../services/app_updates';

export function useAppUpdates() {
  return useSyncExternalStore(appUpdates.subscribe, appUpdates.getSnapshot);
}
