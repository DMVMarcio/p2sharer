import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, AppWindow, Building2, FolderOpen, Download } from 'lucide-react';
import { ChoiceCards } from './ChoiceCards';
import { SystemIcon } from './SystemIcon';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useContentPresence } from '../../hooks/useContentPresence';

interface DownloadCatalog { version: string | null; platforms: { id: string; artifacts: { id: string; url: string; size: number }[] }[] }
const systems = [{ id: 'windows', label: 'Windows' }, { id: 'macos', label: 'macOS' }, { id: 'linux', label: 'Linux' }];
const formats = [{ id: 'installer', icon: AppWindow }, { id: 'msi', icon: Building2 }, { id: 'portable', icon: FolderOpen }];

export function DownloadPanel({ compact = false }: { compact?: boolean }) {
  useLocale();
  const [catalog, setCatalog] = useState<DownloadCatalog | null>(null);
  const [platform, setPlatform] = useState('windows');
  const [format, setFormat] = useState('installer');
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
    void fetch('/api/downloads', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Downloads unavailable');
      const value = await response.json() as DownloadCatalog;
      if (!controller.signal.aborted) setCatalog(value);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [attempt]);
  const artifacts = catalog?.platforms.find(item => item.id === platform)?.artifacts ?? [];
  const selected = artifacts.find(item => item.id === format);
  return <section className={`download-panel${compact ? ' download-panel-compact' : ''}`} aria-label={t('downloads.title')}>
    <div className="download-steps" aria-label={t('downloads.title')}>
      <span aria-current={step === 'system' ? 'step' : undefined}>1 · {t('downloads.system')}</span>
      <span aria-current={step === 'format' ? 'step' : undefined}>2 · {t('downloads.format')}</span>
    </div>
    <div className={`content-transition${presence.closing ? ' content-exiting' : ''}`} inert={presence.closing}>
      <h2 className="download-step-heading" ref={heading} tabIndex={-1}>{t(`downloads.${presence.value}`)}</h2>
      {presence.value === 'system' ? <div className="download-systems">
        {systems.map(system => <button key={system.id} type="button" className="btn btn-secondary download-system" onClick={() => {
          setPlatform(system.id);
          setFormat(catalog?.platforms.find(item => item.id === system.id)?.artifacts[0]?.id ?? 'installer');
          setStep('format');
        }}><SystemIcon system={system.id} /><strong>{system.label}</strong>
          {catalog && !catalog.platforms.find(item => item.id === system.id)?.artifacts.length && <small>{t('downloads.unavailable')}</small>}
        </button>)}
      </div> : <>
        <button className="btn btn-ghost btn-sm download-back" onClick={() => setStep('system')}><ArrowLeft size={15} aria-hidden="true" />{t('downloads.system')}</button>
        <p className="download-platform"><SystemIcon system={platform} />{systems.find(system => system.id === platform)?.label}{platform === 'windows' ? ' · x64' : ''}</p>
        {catalog && <>
          {artifacts.length ? <>
            <ChoiceCards label={t('downloads.format')} value={format} onChange={setFormat} options={formats.map(({ id, icon: Icon }) => ({
              value: id, label: `${t(`downloads.${id}`)} (${id === 'msi' ? '.msi' : '.exe'})`, icon: <Icon size={19} />,
              description: `${t(`downloads.${id}Text`)}${!artifacts.some(item => item.id === id) ? ` ${t('downloads.unavailable')}` : ''}`, disabled: !artifacts.some(item => item.id === id),
            }))} />
            {selected && <div className="download-action"><a className="btn btn-primary" href={selected.url}><Download size={17} aria-hidden="true" />{t('common.download')}</a>
              <small>v{catalog.version} · {Math.ceil(selected.size / 1024 / 1024)} MB</small></div>}
          </> : <p role="status">{t('downloads.unavailable')}</p>}
        </>}
      </>}
    </div>
    {!catalog && !error && <p role="status">{t('downloads.loading')}</p>}
    {error && <div role="alert"><p>{t('downloads.error')}</p><button className="btn btn-secondary btn-sm" onClick={() => setAttempt(value => value + 1)}>{t('downloads.retry')}</button></div>}
  </section>;
}
