import { useEffect, useState } from 'react';
import { AppWindow, Building2, FolderOpen, Download } from 'lucide-react';
import { Select } from './Select';
import { ChoiceCards } from './ChoiceCards';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';

interface DownloadCatalog { version: string | null; platforms: { id: string; artifacts: { id: string; url: string; size: number }[] }[] }
const systems = [{ id: 'windows', label: 'Windows' }, { id: 'macos', label: 'macOS' }, { id: 'linux', label: 'Linux' }];
const formats = [{ id: 'installer', icon: AppWindow }, { id: 'msi', icon: Building2 }, { id: 'portable', icon: FolderOpen }];

export function DownloadPanel() {
  useLocale();
  const [catalog, setCatalog] = useState<DownloadCatalog | null>(null);
  const [platform, setPlatform] = useState('windows');
  const [format, setFormat] = useState('installer');
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setError(false); setCatalog(null);
    void fetch('/api/downloads', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Downloads unavailable');
      const value = await response.json() as DownloadCatalog;
      if (!controller.signal.aborted) { setCatalog(value); setFormat(value.platforms.find(item => item.id === 'windows')?.artifacts[0]?.id ?? 'installer'); }
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [attempt]);
  const artifacts = catalog?.platforms.find(item => item.id === platform)?.artifacts ?? [];
  const selected = artifacts.find(item => item.id === format);
  return <section className="download-panel" aria-label={t('downloads.title')}>
    <p>{t('downloads.intro')}</p>
    <Select aria-label={t('downloads.system')} value={platform} onValueChange={value => {
      setPlatform(value); setFormat(catalog?.platforms.find(item => item.id === value)?.artifacts[0]?.id ?? 'installer');
    }} options={systems.map(system => ({ value: system.id, label: `${system.label}${catalog && !catalog.platforms.find(item => item.id === system.id)?.artifacts.length ? ` · ${t('downloads.unavailable')}` : ''}` }))} />
    {catalog && <>
      {platform === 'windows' ? <ChoiceCards label={t('downloads.format')} value={format} onChange={setFormat} options={formats.map(({ id, icon: Icon }) => ({
        value: id, label: `${t(`downloads.${id}`)}${id === 'msi' ? '' : ' (.exe)'}`, icon: <Icon size={24} />,
        description: `${t(`downloads.${id}Text`)}${!artifacts.some(item => item.id === id) ? ` ${t('downloads.unavailable')}` : ''}`,
        disabled: !artifacts.some(item => item.id === id),
      }))} /> : <p role="status">{t('downloads.unavailable')}</p>}
      {selected && <a className="btn btn-primary" href={selected.url}><Download size={17} aria-hidden="true" />
        {t('common.download')} · v{catalog.version} · {Math.ceil(selected.size / 1024 / 1024)} MB</a>}
    </>}
    {!catalog && !error && <p role="status">{t('downloads.loading')}</p>}
    {error && <div role="alert"><p>{t('downloads.error')}</p><button className="btn btn-secondary" onClick={() => setAttempt(value => value + 1)}>{t('downloads.retry')}</button></div>}
  </section>;
}
