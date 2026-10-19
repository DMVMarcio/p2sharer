import { Download } from 'lucide-react';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';

export interface DownloadArtifact { id: string; url: string; size: number }
const formats = [{ id: 'installer', extension: 'EXE' }, { id: 'msi', extension: 'MSI' }, { id: 'portable', extension: 'EXE' }];

/** Each available package is a direct download; there is no intermediate format selection. */
export function DownloadFiles({ artifacts }: { artifacts: DownloadArtifact[] }) {
  useLocale();
  return <ul className="download-files" aria-label={t('downloads.format')}>
    {formats.map(({ id, extension }) => {
      const file = artifacts.find(item => item.id === id);
      return <li key={id} className={`download-file${file ? '' : ' is-unavailable'}`}>
        <span className="download-file-extension" aria-hidden="true">{extension}</span>
        <div className="download-file-info"><h3>{t(`downloads.${id}`)}</h3><p>{t(`downloads.${id}Text`)}</p></div>
        {file ? <><small>{Math.ceil(file.size / 1024 / 1024)} MB</small>
          <a className="btn btn-secondary btn-sm" href={file.url} aria-label={`${t('common.download')} · ${t(`downloads.${id}`)}`}><Download size={15} aria-hidden="true" />{t('common.download')}</a></> :
          <button className="btn btn-secondary btn-sm" disabled>{t('downloads.unavailable')}</button>}
      </li>;
    })}
  </ul>;
}
