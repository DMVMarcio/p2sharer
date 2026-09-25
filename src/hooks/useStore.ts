import { useSyncExternalStore, useRef } from 'react';
import { stateStore, StateStore } from '../core/state_store';

export function useStore<T>(
  selector: (state: StateStore) => T,
  isEqual: (a: T, b: T) => boolean = Object.is
): T {
  const lastValueRef = useRef<T | undefined>(undefined);
  const hasValueRef = useRef(false);

  return useSyncExternalStore(
    (callback) => stateStore.subscribe(callback),
    () => {
      const next = selector(stateStore);
      if (!hasValueRef.current || !isEqual(lastValueRef.current as T, next)) {
        lastValueRef.current = next;
        hasValueRef.current = true;
      }
      return lastValueRef.current as T;
    },
    () => {
      const next = selector(stateStore);
      if (!hasValueRef.current || !isEqual(lastValueRef.current as T, next)) {
        lastValueRef.current = next;
        hasValueRef.current = true;
      }
      return lastValueRef.current as T;
    }
  );
}
