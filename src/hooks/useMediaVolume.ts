import { useRef, useState } from 'react';
import { getSessionAppVolume, saveSessionAppVolume } from '../core/stream_volume_preferences';

/** Keep the last audible level across control remounts, fullscreen changes, and while the app stays open. */
export function useMediaVolume(initial = 1, sessionKey?: string) {
  const saved = getSessionAppVolume(sessionKey);
  const initialVolume = saved ? (saved.isMuted ? 0 : saved.volume / 100) : initial;
  const [volume, setVolume] = useState(saved ? saved.volume / 100 : initial);
  const [muted, setMuted] = useState(saved ? saved.isMuted : initial === 0);
  const lastVolume = useRef((saved ? saved.volume / 100 : initialVolume) || 1);
  const changeVolume = (next: number) => {
    const clamped = Math.max(0, Math.min(1, next));
    setVolume(clamped);
    setMuted(clamped === 0);
    if (clamped > 0) lastVolume.current = clamped;
    saveSessionAppVolume(sessionKey, clamped * 100, clamped === 0);
  };
  return { volume, muted, changeVolume,
    toggleMute() {
      if (muted || volume === 0) {
        const restored = lastVolume.current || 1;
        setVolume(restored);
        setMuted(false);
        saveSessionAppVolume(sessionKey, restored * 100, false);
      } else {
        setMuted(true);
        saveSessionAppVolume(sessionKey, volume * 100, true);
      }
    },
  };
}
