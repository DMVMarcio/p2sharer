import { useRef, useState } from 'react';

/** Keep the last audible level across control remounts and fullscreen changes. */
export function useMediaVolume(initial = 1) {
  const [volume, setVolume] = useState(initial);
  const [muted, setMuted] = useState(initial === 0);
  const lastVolume = useRef(initial || 1);
  const changeVolume = (next: number) => {
    setVolume(next); setMuted(next === 0);
    if (next > 0) lastVolume.current = next;
  };
  return { volume, muted, changeVolume,
    toggleMute() { changeVolume(muted || volume === 0 ? lastVolume.current : 0); },
  };
}
