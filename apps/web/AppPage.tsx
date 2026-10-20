import { useEffect, useMemo, useRef } from 'react';
import { useBlocker, useLocation, useNavigate } from 'react-router';
import App from '../../src/App';
import { AppContextMenu } from '../../src/components/common/AppContextMenu';
import { initializeAppRuntime } from '../../src/core/app_runtime';
import { stateStore } from '../../src/core/state_store';
import { roomCodeFromPath } from '../../src/core/web_room_links';
import { parseRoomInvite } from '../../src/core/room_invite';
import { roomService } from '../../src/services/room_service';
import type { WebRoomNavigation } from '../../src/services/web_room_navigation';
import '../../src/components/room/stream_pointer.css';
import '../../src/apps/apps.css';

initializeAppRuntime();

export function Component() {
  const navigate = useNavigate();
  const location = useLocation();
  const confirm = useRef<(() => Promise<boolean>) | null>(null);
  const leaving = useRef(false);
  const previousLocation = useRef(location.key);
  const listeners = useRef(new Set<() => void>());
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (!stateStore.roomSlots.length || currentLocation.pathname === nextLocation.pathname) return false;
    const active = parseRoomInvite(stateStore.currentRoomInvite)?.roomId;
    return roomCodeFromPath(nextLocation.pathname) !== active;
  });
  const navigation = useMemo<WebRoomNavigation>(() => ({
    replace: path => { if (!leaving.current) void navigate(path, { replace: true }); },
    subscribe: listener => { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; },
    registerExit: callback => { confirm.current = callback; return () => { confirm.current = null; }; },
  }), [navigate]);

  useEffect(() => {
    leaving.current = false;
    if (previousLocation.current !== location.key) listeners.current.forEach(listener => listener());
    previousLocation.current = location.key;
  }, [location]);

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    let cancelled = false;
    void (async () => {
      try {
        if (!await confirm.current?.() || cancelled) { if (!cancelled) blocker.reset(); return; }
        leaving.current = true;
        await roomService.leaveRoom();
        if (!cancelled) blocker.proceed();
      } catch {
        leaving.current = false;
        if (!cancelled) blocker.reset();
      }
    })();
    return () => { cancelled = true; };
  }, [blocker]);

  return <AppContextMenu><App webNavigation={navigation} /></AppContextMenu>;
}
