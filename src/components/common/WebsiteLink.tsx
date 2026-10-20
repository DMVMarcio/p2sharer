import type { ComponentProps } from 'react';
import { Link, useInRouterContext } from 'react-router';

/** Desktop URLs and explicit new tabs keep normal browser semantics. */
export function WebsiteLink({ href = '/', ...props }: ComponentProps<'a'>) {
  const routed = useInRouterContext();
  const url = new URL(href, window.location.href);
  if (routed && !href.startsWith('#') && url.origin === window.location.origin && (!props.target || props.target === '_self') && !props.download) {
    return <Link {...props} viewTransition to={`${url.pathname}${url.search}${url.hash}`} />;
  }
  return <a {...props} href={href} />;
}
