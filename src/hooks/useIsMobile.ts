import { useState, useEffect } from 'react';
import { isMobileDevice } from '../core/platform';

/**
 * Reactive hook that updates whenever the client window dimensions or
 * pointer capabilities cross mobile / touch breakpoints.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => isMobileDevice());

  useEffect(() => {
    const handleUpdate = () => {
      setIsMobile(isMobileDevice());
    };

    window.addEventListener('resize', handleUpdate);
    window.addEventListener('orientationchange', handleUpdate);

    const mqlCoarse = typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: none) and (pointer: coarse)')
      : null;
    const mqlWidth = typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 900px)')
      : null;
    const mqlHeight = typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-height: 540px)')
      : null;

    mqlCoarse?.addEventListener?.('change', handleUpdate);
    mqlWidth?.addEventListener?.('change', handleUpdate);
    mqlHeight?.addEventListener?.('change', handleUpdate);

    return () => {
      window.removeEventListener('resize', handleUpdate);
      window.removeEventListener('orientationchange', handleUpdate);
      mqlCoarse?.removeEventListener?.('change', handleUpdate);
      mqlWidth?.removeEventListener?.('change', handleUpdate);
      mqlHeight?.removeEventListener?.('change', handleUpdate);
    };
  }, []);

  return isMobile;
}
