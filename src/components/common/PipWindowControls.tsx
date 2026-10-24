import { useEffect, useMemo, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Square } from 'lucide-react';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { Tooltip } from './Tooltip';

/** Native caption actions shared by stream and app PiP headers. */
export function PipWindowControls({ fullscreen = false, onTooltipOpenChange }: {
  fullscreen?: boolean;
  onTooltipOpenChange?: (open: boolean) => void;
}) {
  useLocale();
  const nativeWindow = useMemo(() => isTauri() ? getCurrentWindow() : null, []);
  const [maximized, setMaximized] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!nativeWindow) return;
    let disposed = false;
    let revision = 0;
    let remove: (() => void) | undefined;
    const refresh = async () => {
      const request = ++revision;
      const value = await nativeWindow.isMaximized();
      if (!disposed && request === revision) setMaximized(value);
    };
    const report = (error: unknown) => console.warn('[PiP] Could not read window state:', error);
    void nativeWindow.onResized(() => { void refresh().catch(report); }).then(unlisten => {
      if (disposed) unlisten(); else remove = unlisten;
    }).catch(report);
    void refresh().catch(report);
    return () => { disposed = true; remove?.(); };
  }, [nativeWindow]);
  if (!nativeWindow || fullscreen) return null;
  const run = async (action: 'minimize' | 'toggleMaximize') => {
    if (busy) return;
    setBusy(true);
    try {
      await nativeWindow[action]();
      setMaximized(await nativeWindow.isMaximized());
    } catch (error) { console.warn('[PiP] Window action failed:', error); }
    finally { setBusy(false); }
  };
  const maximizeLabel = t(maximized ? 'message.eda02893d340' : 'message.092b9ccfbf63');
  return <>
    <Tooltip content={t('message.3fc5f90b27f1')} onOpenChange={onTooltipOpenChange}>
      <button type="button" className="pip-header-btn" aria-label={t('message.3fc5f90b27f1')}
        disabled={busy} onClick={() => void run('minimize')}><Minus size={15} aria-hidden="true" /></button>
    </Tooltip>
    <Tooltip content={maximizeLabel} onOpenChange={onTooltipOpenChange}>
      <button type="button" className="pip-header-btn" aria-label={maximizeLabel}
        disabled={busy} onClick={() => void run('toggleMaximize')}>
        {maximized ? <Copy size={14} aria-hidden="true" /> : <Square size={14} aria-hidden="true" />}
      </button>
    </Tooltip>
  </>;
}
