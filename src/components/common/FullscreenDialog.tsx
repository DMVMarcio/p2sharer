import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { ModalDialog } from './ModalDialog';

/** Fullscreen content keeps the canonical portal, focus trap and overlay dismissal order. */
export function FullscreenDialog({ title, children, onClose, closeRef }: {
  title: string; children: ReactNode; onClose: () => void; closeRef: RefObject<(() => void) | null>;
}) {
  const closeCallback = useRef<(() => void) | null>(null);
  useEffect(() => { closeRef.current = closeCallback.current; return () => { closeRef.current = null; }; }, [closeRef]);
  return <ModalDialog title={title} headerless className="fullscreen-dialog" onClose={onClose}
    footer={close => { closeCallback.current = close; closeRef.current = close; return null; }}>{children}</ModalDialog>;
}
