import { useEffect, useRef, useState } from 'react';
import { overlayMotionDuration } from '../core/overlay_motion.ts';

/** Standalone dialogs retain inert content until their shared exit motion completes. */
export function useDialogDismiss(onClose: () => void, busy = false) {
  const callback = useRef(onClose);
  const blocked = useRef(busy);
  const closingRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [closing, setClosing] = useState(false);
  callback.current = onClose;
  blocked.current = busy;
  const close = () => {
    if (blocked.current || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    timer.current = setTimeout(() => callback.current(), overlayMotionDuration('dialog', false));
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return { closing, close };
}
