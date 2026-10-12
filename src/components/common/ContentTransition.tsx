import type { ReactNode } from 'react';
import { useContentPresence } from '../../hooks/useContentPresence';

interface Props<T extends string> {
  value: T;
  className?: string;
  children: (value: T) => ReactNode;
}

export function ContentTransition<T extends string>({ value, className = '', children }: Props<T>) {
  const presence = useContentPresence(value);
  return <div key={presence.value} className={`content-transition ${presence.closing ? 'content-exiting' : ''} ${className}`}
    inert={presence.closing || undefined} aria-hidden={presence.closing || undefined}>
    {children(presence.value)}
  </div>;
}
