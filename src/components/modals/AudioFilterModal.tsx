import { useEffect, useState } from 'react';
import { AppWindow, ChevronRight, Headphones, RefreshCw, Search, Volume2, VolumeX, X } from 'lucide-react';
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
  const [expandedApps, setExpandedApps] = useState(() => new Set<string>());
  const filter = useAudioFilter();
  const { loadProcesses } = filter;
  useEffect(() => { void loadProcesses(); }, [loadProcesses]);
  const choice = filter.captureChoice;
  const options = (['exclude', 'include', 'full', 'none'] as const).map(value => ({ value, label: t(`audio.choice.${value}`) }));

  const toggleExpand = (appKey: string) => {
    setExpandedApps(prev => {
      const next = new Set(prev);
      if (next.has(appKey)) next.delete(appKey);
      else next.add(appKey);
      return next;
    });
  };

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
            <span className="audio-selection-count">{filter.selectedNames.size || filter.selectedPids.size}</span>
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
                const appKey = audioProcessKey(process.name);
                const selectionState = filter.getProcessSelectionState(process);
                const subProcesses = process.sub_processes && process.sub_processes.length > 0
                  ? process.sub_processes
                  : [{ pid: process.pid, window_title: process.window_title, has_audio: false }];
                const hasMultiple = subProcesses.length > 1;
                const searchLower = filter.searchText.trim().toLowerCase();
                const searchMatchesSub = Boolean(searchLower) && subProcesses.some(s =>
                  s.pid.toString().includes(searchLower) ||
                  Boolean(s.window_title && s.window_title.toLowerCase().includes(searchLower))
                );
                const isExpanded = expandedApps.has(appKey) || searchMatchesSub;
                const labels = audioProcessLabels(process.name, process.window_title);

                return <div key={`${process.pid}_${process.name}`} className="audio-filter-app-group">
                  <div
                    className={`settings-switch-row audio-filter-app ${selectionState !== 'none' ? 'selected' : ''}`}
                    onClick={() => {
                      if (hasMultiple) {
                        toggleExpand(appKey);
                      } else {
                        filter.toggleProcess(process, selectionState !== 'all');
                      }
                    }}
                    role={hasMultiple ? 'button' : undefined}
                    tabIndex={hasMultiple ? 0 : undefined}
                    aria-expanded={hasMultiple ? isExpanded : undefined}
                    onKeyDown={(e) => {
                      if (hasMultiple && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        toggleExpand(appKey);
                      }
                    }}
                  >
                    <div className="audio-filter-app-main-info">
                      {hasMultiple ? (
                        <button
                          type="button"
                          className={`audio-filter-expand-btn ${isExpanded ? 'expanded' : ''}`}
                          aria-expanded={isExpanded}
                          aria-label={t(isExpanded ? 'audio.collapseProcesses' : 'audio.expandProcesses', { app: process.name })}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(appKey);
                          }}
                        >
                          <ChevronRight size={16} aria-hidden="true" />
                        </button>
                      ) : (
                        <span className="audio-filter-expand-spacer" aria-hidden="true" />
                      )}
                      <span className="audio-filter-app-icon">
                        {process.icon_base64 && !failedIcons.has(process.icon_base64)
                          ? <img src={process.icon_base64} alt="" onError={() => setFailedIcons(previous => new Set(previous).add(process.icon_base64!))} />
                          : <AppWindow size={20} aria-hidden="true" />}
                      </span>
                      <div className="audio-filter-app-details">
                        <div className="audio-filter-app-title-row">
                          <span className="audio-filter-app-name">{labels.title}</span>
                          {hasMultiple && (
                            <span className="audio-filter-process-badge">
                              {t('audio.processCount', { count: subProcesses.length })}
                            </span>
                          )}
                        </div>
                        <span className="audio-filter-app-executable">{labels.executable}</span>
                      </div>
                    </div>
                    <label className="modern-switch" onClick={(e) => e.stopPropagation()}>
                      <input
                        ref={(el) => {
                          if (el) el.indeterminate = selectionState === 'partial';
                        }}
                        autoComplete="off"
                        type="checkbox"
                        disabled={pending}
                        checked={selectionState === 'all'}
                        aria-label={t(choice === 'exclude' ? 'audio.muteApp' : 'audio.allowApp', { app: process.name })}
                        onChange={(event) => {
                          const nextChecked = selectionState === 'partial' ? true : event.target.checked;
                          filter.toggleProcess(process, nextChecked);
                        }}
                      />
                      <span className="switch-slider" />
                    </label>
                  </div>

                  {isExpanded && (
                    <div className="audio-filter-subprocesses" role="group" aria-label={t('audio.expandProcesses', { app: process.name })}>
                      {subProcesses.map((sub) => {
                        const isSubSelected = filter.selectedPids.has(sub.pid);
                        const subTitle = sub.window_title?.trim() || t('audio.backgroundProcess');
                        return (
                          <label
                            key={`${sub.pid}_${process.name}`}
                            className={`settings-switch-row audio-filter-sub-row ${isSubSelected ? 'selected' : ''}`}
                          >
                            <div className="audio-filter-sub-details">
                              <span className="audio-filter-pid-badge">PID {sub.pid}</span>
                              <span className="audio-filter-sub-title" title={subTitle}>
                                {subTitle}
                              </span>
                              {sub.has_audio && (
                                <span className="audio-filter-audio-badge" title={t('audio.activeAudio')}>
                                  <Volume2 size={12} aria-hidden="true" />
                                  <span>{t('audio.activeAudio')}</span>
                                </span>
                              )}
                            </div>
                            <span className="modern-switch">
                              <input
                                autoComplete="off"
                                type="checkbox"
                                disabled={pending}
                                checked={isSubSelected}
                                aria-label={t(choice === 'exclude' ? 'audio.muteProcess' : 'audio.allowProcess', { pid: sub.pid })}
                                onChange={(event) => filter.toggleSubProcess(process, sub.pid, event.target.checked)}
                              />
                              <span className="switch-slider" />
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>;
              })}
          </div>
          {(filter.selectedNames.size > 0 || filter.selectedPids.size > 0) && <button type="button" disabled={pending} className="btn btn-ghost btn-sm audio-clear-selection"
            onClick={filter.clearSelection}>{t('message.4af6af276835')}</button>}
        </div>}
    </div>
  </ModalDialog>;
};
