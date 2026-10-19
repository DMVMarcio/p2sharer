/** Monochrome operating-system marks, inheriting the application's theme color. */
export function SystemIcon({ system }: { system: string }) {
  return <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    {system === 'windows' ? <path d="M2 4.5 10.5 3.3v8H2zm9.5-1.4L22 1.5v9.8H11.5zM2 12.5h8.5v8L2 19.3zm9.5 0H22v10l-10.5-1.6z" /> :
      system === 'macos' ? <path d="M17.1 12.3c0-2 1.6-3 1.7-3.1-1-1.5-2.5-1.7-3.1-1.7-1.3-.1-2.5.8-3.2.8-.6 0-1.6-.8-2.7-.8-1.4 0-2.7.8-3.5 2-1.5 2.5-.4 6.3 1.1 8.4.7 1.1 1.6 2.3 2.8 2.2 1.1 0 1.5-.7 2.9-.7 1.3 0 1.7.7 2.9.7s2-1.1 2.7-2.2c.9-1.2 1.2-2.5 1.3-2.6-.1 0-2.9-1.1-2.9-3M15 6c.6-.8 1.1-1.8 1-2.8-1 .1-2 .7-2.7 1.5-.6.7-1.1 1.8-1 2.8 1 .1 2-.5 2.7-1.5" /> :
        <g stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><path d="M8 9C7 3 9 2 12 2s5 1 4 7l3 7-3 3H8l-3-3z" /><ellipse cx="12" cy="14" rx="4" ry="5" fill="var(--bg-elevated)" /><path d="m9 7 3 2 3-2-3-1zM8 18l-5 3h7zm8 0 5 3h-7z" /><path d="M10 5h.1M14 5h.1" stroke="var(--bg-elevated)" strokeWidth="2" strokeLinecap="round" /></g>}
  </svg>;
}
