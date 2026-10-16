import { useEffect, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Invalidate only device-local saved bindings, including detached app windows. */
export function useDocumentLibraryDeletion(library: 'notes' | 'whiteboard', onDelete: (id: string) => void) {
  const callback = useRef(onDelete);
  callback.current = onDelete;
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const subscription = listen<{ id: string; library: string }>('document-library-deleted', ({ payload }) => {
      if (!disposed && payload.library === library && typeof payload.id === 'string') callback.current(payload.id);
    });
    void subscription.catch(reason => console.warn('[Documents] Could not subscribe to library changes:', reason));
    return () => { disposed = true; void subscription.then(stop => stop()).catch(() => {}); };
  }, [library]);
}
