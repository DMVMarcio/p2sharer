import { useState } from 'react';
import { useIdleControls } from './useIdleControls';

/** Explicit collapse takes precedence over fullscreen pointer/idle visibility. */
export function useBrowserChrome(fullscreen: boolean) {
  const idle = useIdleControls(fullscreen);
  const [collapsed, setCollapsed] = useState(false);
  return {
    ...idle, collapsed, visible: !collapsed && idle.visible,
    collapse() { setCollapsed(true); idle.release('pointer'); idle.release('focus'); },
    expand() { setCollapsed(false); idle.reveal(); },
  };
}
