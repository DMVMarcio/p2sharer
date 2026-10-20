import { apiUrl } from '../../platform/website';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { DownloadFiles, type DownloadArtifact } from './DownloadFiles';
import { TooltipButton } from './TooltipButton';
import { SystemIcon } from './SystemIcon';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useContentPresence } from '../../hooks/useContentPresence';

interface DownloadCatalog { version: string | null; platforms: { id: string; artifacts: DownloadArtifact[] }[] }
const systems = [{ id: 'windows', label: 'Windows' }, { id: 'macos', label: 'macOS' }, { id: 'linux', label: 'Linux' }];

export function DownloadPanel() {
  useLocale();
  const [catalog, setCatalog] = useState<DownloadCatalog | null>(null);
  const [platform, setPlatform] = useState('windows');
  const [step, setStep] = useState<'system' | 'format'>('system');
  const presence = useContentPresence(step);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(presence.value);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (previousStep.current !== presence.value) heading.current?.focus();
    previousStep.current = presence.value;
  }, [presence.value]);
  useEffect(() => {
    const controller = new AbortController(); setError(false); setCatalog(null);
    void fetch(apiUrl('/api/downloads'), { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Downloads unavailable');
      const value = await response.json() as DownloadCatalog;
      if (!controller.signal.aborted) setCatalog(value);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [attempt]);
  const artifacts = catalog?.platforms.find(item => item.id === platform)?.artifacts ?? [];
  return <section className="download-panel" aria-label={t('downloads.title')}>
    <div className="download-steps" aria-label={t('downloads.title')}>
      <span aria-current={step === 'system' ? 'step' : undefined}>1 · {t('downloads.system')}</span>
      <span aria-current={step === 'format' ? 'step' : undefined}>2 · {t('downloads.format')}</span>
    </div>
    <div className={`content-transition${presence.closing ? ' content-exiting' : ''}`} inert={presence.closing}>
      <div className="download-step-header">
        {presence.value === 'format' && <TooltipButton tooltip={t('downloads.system')} aria-label={t('downloads.system')}
          className="btn-icon-header download-back" onClick={() => setStep('system')}><ArrowLeft size={19} aria-hidden="true" /></TooltipButton>}
        <h2 className="download-step-heading" ref={heading} tabIndex={-1}>{t(`downloads.${presence.value}`)}</h2>
      </div>
      {presence.value === 'system' ? <div className="download-systems">
        {systems.map(system => <button key={system.id} type="button" className="btn btn-secondary download-system" disabled={!catalog?.platforms.find(item => item.id === system.id)?.artifacts.length} onClick={() => {
          setPlatform(system.id);
          setStep('format');
        }}><SystemIcon system={system.id} /><strong>{system.label}</strong>
          {catalog && !catalog.platforms.find(item => item.id === system.id)?.artifacts.length && <small>{t('downloads.unavailable')}</small>}
        </button>)}
      </div> : <>
        <p className="download-platform"><SystemIcon system={platform} />{systems.find(system => system.id === platform)?.label}{platform === 'windows' ? ' · x64' : ''}{catalog?.version && <span>v{catalog.version}</span>}</p>
        {catalog && <>
          {artifacts.length ? <DownloadFiles artifacts={artifacts} /> : <p role="status">{t('downloads.unavailable')}</p>}
        </>}
      </>}
    </div>
    {!catalog && !error && <p role="status">{t('downloads.loading')}</p>}
    {error && <div role="alert"><p>{t('downloads.error')}</p><button className="btn btn-secondary btn-sm" onClick={() => setAttempt(value => value + 1)}>{t('downloads.retry')}</button></div>}
  </section>;
}
