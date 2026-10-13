import { useEffect, useState } from 'react';
import { AppWindow, Headphones, RefreshCw, Search, Volume2, VolumeX, X } from 'lucide-react';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useModal } from '../../hooks/useModal';
import { useAudioFilter } from '../../hooks/useAudioFilter';
import { audioProcessKey, audioProcessLabels, type AudioCaptureChoice } from '../../core/audio_filter_presets';
import { ModalDialog } from '../common/ModalDialog';
import { Select } from '../common/Select';
import { TooltipButton } from '../common/TooltipButton';

export const AudioFilterModal = () => {
  useLocale();
  const { closeModal } = useModal();
  const [pending, setPending] = useState(false);
  const [failedIcons, setFailedIcons] = useState(() => new Set<string>());
  const filter = useAudioFilter();
  const { loadProcesses } = filter;
  useEffect(() => { void loadProcesses(); }, [loadProcesses]);
  const choice = filter.captureChoice;
  const options = (['exclude', 'include', 'full', 'none'] as const).map(value => ({ value, label: t(`audio.choice.${value}`) }));

  return <ModalDialog title={t('message.cd9f9a4fe6f8')} icon={<Headphones size={20} />}
    className="audio-filter-modal-card" busy={pending} onClose={closeModal}
    footer={close => <>
      <button type="button" className="btn btn-secondary" disabled={pending} onClick={close}>{t('message.bb9dbb406dcb')}</button>
      <button type="button" className="btn btn-primary" disabled={pending} aria-busy={pending} onClick={async () => {
        setPending(true);
        try { if (await filter.applyFilters()) close(); }
        finally { setPending(false); }
      }}>{t('message.3a04898a6b8b')}</button>
    </>}>
    <div className="audio-filter-content">
      <label className="form-label" htmlFor="audio-capture-choice">{t('audio.captureChoice')}</label>
      <Select id="audio-capture-choice" className="text-input" disabled={pending}
        value={filter.captureChoice} options={options}
        onValueChange={value => filter.setCaptureChoice(value as AudioCaptureChoice)} />
      {choice === 'full' || choice === 'none' ? <div className="audio-choice-notice">
          {choice === 'full' ? <Volume2 size={23} /> : <VolumeX size={23} />}
          <span>{t(`audio.hint.${choice}`)}</span>
        </div> : <div className="audio-app-controls">
          <div className="audio-list-heading">
            <span>{t(choice === 'exclude' ? 'audio.mutedApps' : 'audio.allowedApps')}</span>
            <span className="audio-selection-count">{filter.selectedNames.size}</span>
          </div>
          <p className="audio-choice-hint">{t(`audio.hint.${choice}`)}</p>
          <div className="audio-filter-search">
            <Search size={16} aria-hidden="true" />
            <input autoComplete="off" className="text-input" disabled={pending} value={filter.searchText}
              aria-label={t('message.d5c1ff19ba78')} placeholder={t('message.d5c1ff19ba78')}
              onChange={event => filter.setSearchText(event.target.value)} />
            {filter.searchText && <TooltipButton className="btn-close" tooltip={t('message.9f3ebbde555a')}
              onClick={() => filter.setSearchText('')}><X size={15} /></TooltipButton>}
            <TooltipButton className="btn btn-secondary audio-filter-refresh" disabled={filter.isLoading || pending}
              tooltip={t('message.cea1be571207')} onClick={() => void loadProcesses()}>
              <RefreshCw size={17} className={filter.isLoading ? 'audio-refresh-spinning' : ''} />
            </TooltipButton>
          </div>
          <div className="audio-filter-app-list" aria-busy={filter.isLoading}>
            {filter.isLoading ? <div className="audio-filter-list-state" role="status"><span className="loading-spinner" />{t('message.7cbee137622b')}</div>
              : filter.processes.length === 0 ? <div className="audio-filter-list-state">{t('audio.noApps')}</div>
              : filter.processes.map(process => {
                const selected = filter.selectedNames.has(audioProcessKey(process.name));
                const labels = audioProcessLabels(process.name, process.window_title);
                return <label key={`${process.pid}_${process.name}`} className={`settings-switch-row audio-filter-app ${selected ? 'selected' : ''}`}>
                  <span className="audio-filter-app-icon">
                    {process.icon_base64 && !failedIcons.has(process.icon_base64)
                      ? <img src={process.icon_base64} alt="" onError={() => setFailedIcons(previous => new Set(previous).add(process.icon_base64!))} />
                      : <AppWindow size={20} aria-hidden="true" />}
                  </span>
                  <span className="audio-filter-app-details">
                    <span className="audio-filter-app-name">{labels.title}</span>
                    <span className="audio-filter-app-executable">{labels.executable}</span>
                  </span>
                  <span className="modern-switch">
                    <input autoComplete="off" type="checkbox" disabled={pending} checked={selected}
                      aria-label={t(choice === 'exclude' ? 'audio.muteApp' : 'audio.allowApp', { app: process.name })}
                      onChange={event => filter.toggleProcess(process, event.target.checked)} />
                    <span className="switch-slider" />
                  </span>
                </label>;
              })}
          </div>
          {filter.selectedNames.size > 0 && <button type="button" disabled={pending} className="btn btn-ghost btn-sm audio-clear-selection"
            onClick={filter.clearSelection}>{t('message.4af6af276835')}</button>}
        </div>}
    </div>
  </ModalDialog>;
};
