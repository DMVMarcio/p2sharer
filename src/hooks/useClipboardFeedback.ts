import { useCallback, useEffect, useRef, useState } from 'react';

/** Only acknowledge successful writes for the current value and mounted control. */
export function useClipboardFeedback(value: string, durationMs = 2200) {
  const [copied, setCopied] = useState(false);
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setCopied(false);
    return () => {
      revision.current++;
      clearTimeout(timer.current);
    };
  }, [value, durationMs]);

  const copy = useCallback(async () => {
    const request = ++revision.current;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return false;
    }
    if (request !== revision.current) return false;
    clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), durationMs);
    return true;
  }, [value, durationMs]);

  return { copied, copy };
}
