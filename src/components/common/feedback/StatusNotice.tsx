import type { ReactNode } from 'react';
import { Info } from 'lucide-react';

export function StatusNotice({ children }: { children: ReactNode }) {
  return <div className="inline-notice" role="status" aria-live="polite">
    <Info size={18} aria-hidden="true" />
    <span>{children}</span>
  </div>;
}
