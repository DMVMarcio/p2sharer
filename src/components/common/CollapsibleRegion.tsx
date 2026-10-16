import { useId, type ReactNode } from 'react';

/** Retains content through reversible height transitions while hiding collapsed controls. */
export function CollapsibleRegion({ open, children, id }: { open: boolean; children: ReactNode; id?: string }) {
  const generatedId = useId();
  return <div id={id ?? generatedId} className={`collapsible-region ${open ? 'is-open' : ''}`} inert={!open || undefined} aria-hidden={!open || undefined}>
    <div className="collapsible-region-content">{children}</div>
  </div>;
}
