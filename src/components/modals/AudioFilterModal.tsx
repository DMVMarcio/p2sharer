import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useEffect, useState } from 'react';
import { useModal } from '../../hooks/useModal';
import { useAudioFilter } from '../../hooks/useAudioFilter';
import { Tooltip } from '../common/Tooltip';

export const AudioFilterModal: React.FC = () => {
  useLocale();
  const [failedIcons, setFailedIcons] = useState<Set<string>>(() => new Set());
  const { closeModal, isClosing } = useModal();
  const {
    processes,
    rawProcessCount,
    isLoading,
    searchText,
    setSearchText,
    isFullAudio,
    setFullAudioMode,
    selectedFilterMode,
    setFilterMode,
    selectedNames,
    toggleProcess,
    selectVoiceApps,
    clearSelection,
    loadProcesses,
    applyFilters,
  } = useAudioFilter();

  useEffect(() => {
    loadProcesses();
  }, [loadProcesses]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeModal]);

  const handleApply = async () => {
    const success = await applyFilters();
    if (success) {
      closeModal();
    }
  };

  const isExclude = selectedFilterMode === 'exclude';
  const selectedCount = selectedNames.size;

  return (
    <div
      className={`modal-overlay ${isClosing ? 'closing' : ''}`}
      id="modal-audio-filter"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          closeModal();
        }
      }}
    >
      <div className="modal-card modal-lg audio-filter-modal-card">
        {/* Modal Header */}
        <div className="modal-header">
          <div>
            <h2>{t("message.cd9f9a4fe6f8")}</h2>
            <p className="modal-subtitle">
              {t("message.f79d4938bb8c")}</p>
          </div>
          <button
            className="btn-close"
            id="btn-close-audio-modal"
            onClick={closeModal}
            aria-label={t("message.0f2bd88ef0ac")}
          >
            &times;
          </button>
        </div>

        <div className="modal-body audio-filter-modal-body">
          {/* Master Unfiltered Switch Card */}
          <div className={`audio-master-switch-card ${isFullAudio ? 'active' : ''}`}>
            <div className="audio-master-switch-info">
              <div className="audio-master-switch-title-row">
                <span className="audio-master-switch-title">{t("message.dcd7a51c1fbd")}</span>
                {isFullAudio && <span className="audio-master-switch-badge">{t("message.5fc7e20f01a4")}</span>}
              </div>
              <p className="audio-master-switch-desc">
                {t("message.d735bc54979c")}</p>
            </div>
            <label className="modern-switch" htmlFor="toggle-full-audio">
              <input autoComplete="off"
                id="toggle-full-audio"
                type="checkbox"
                checked={isFullAudio}
                onChange={(e) => setFullAudioMode(e.target.checked)}
              />
              <span className="switch-slider" />
            </label>
          </div>

          {isFullAudio ? (
            <div className="audio-full-mode-callout">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
              <div>
                <strong>{t("message.f933e62ed746")}</strong>
                <p>{t("message.1fe90c2f5d4b")}</p>
              </div>
            </div>
          ) : (
            <div className="audio-granular-section">
              {/* Sober Native Segmented Control */}
              <div className="audio-segmented-control" role="tablist" aria-label={t("message.408dd2f85c4a")}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isExclude}
                  className={`audio-segment-btn ${isExclude ? 'active' : ''}`}
                  onClick={() => setFilterMode('exclude')}
                >
                  {t("message.fea132673fba")}</button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={!isExclude}
                  className={`audio-segment-btn ${!isExclude ? 'active' : ''}`}
                  onClick={() => setFilterMode('include')}
                >
                  {t("message.ba1d9ee9cb3e")}</button>
              </div>

              {/* Clean Informational Status Line */}
              <div className="audio-info-box">
                {isExclude ? (
                  selectedCount === 0 ? (
                    <span>{t("message.eb76028b0eb9")}</span>
                  ) : (
                    <span>
                      {t("message.2734d756396f")} <strong>{selectedCount}</strong> {t("message.06899e2d53ad")}</span>
                  )
                ) : selectedCount === 0 ? (
                  <span>{t("message.408a2c311897")}</span>
                ) : (
                  <span>
                    {t("message.521b22065b2a")} <strong>{selectedCount}</strong> {t("message.a6ffc768bd58")}</span>
                )}
              </div>

              {/* Action Toolbar */}
              <div className="audio-filter-toolbar">
                <div className="audio-search-input-wrapper">
                  <svg
                    className="audio-search-icon"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input autoComplete="off"
                    type="text"
                    id="input-search-process"
                    className="audio-search-input"
                    placeholder={t("message.d5c1ff19ba78")}
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                  />
                  {searchText && (
                    <button
                      type="button"
                      className="audio-search-clear-btn"
                      onClick={() => setSearchText('')}
                      aria-label={t("message.9f3ebbde555a")}
                    >
                      &times;
                    </button>
                  )}
                </div>

                <div className="audio-toolbar-actions">
                  {isExclude && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost audio-action-btn"
                      onClick={selectVoiceApps}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="1" x2="23" y1="1" y2="23" />
                        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                        <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                        <line x1="12" x2="12" y1="19" y2="23" />
                        <line x1="8" x2="16" y1="23" y2="23" />
                      </svg>
                      <span>{t("message.0feef24e3985")}</span>
                    </button>
                  )}

                  {selectedCount > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost audio-action-btn"
                      onClick={clearSelection}
                    >
                      <span>{t("message.4af6af276835")}</span>
                    </button>
                  )}

                  <Tooltip content={t("message.cea1be571207")}>
                    <button
                      type="button"
                      className={`btn btn-sm btn-outline audio-refresh-btn ${isLoading ? 'spinning' : ''}`}
                      onClick={loadProcesses}
                      aria-label={t("message.bc3205686c5b")}
                      disabled={isLoading}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                        <path d="M21 3v5h-5" />
                        <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                        <path d="M8 16H3v5" />
                      </svg>
                    </button>
                  </Tooltip>
                </div>
              </div>

              {/* Process Items List */}
              <div className="audio-process-list-card" id="process-checkboxes-container">
                {isLoading && (
                  <div className="audio-loading-state">
                    <span className="spinner-sm" />
                    <span>{t("message.7cbee137622b")}</span>
                  </div>
                )}

                {!isLoading && processes.length === 0 && (
                  <div className="audio-empty-state">
                    <span>{t("message.f550813bc0e5")}{searchText}{t("message.8a331fdde703")}</span>
                  </div>
                )}

                {!isLoading &&
                  processes.map((p) => {
                    const nameLower = p.name.toLowerCase();
                    const isSelected = selectedNames.has(nameLower);

                    return (
                      <div
                        key={`${p.pid}_${p.name}`}
                        className={`audio-process-row ${isSelected ? 'selected' : ''}`}
                        onClick={() => toggleProcess(p, !isSelected)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleProcess(p, !isSelected);
                          }
                        }}
                      >
                        {/* Process Icon */}
                        <div className="audio-process-icon">
                          {p.icon_base64 ? (
                            <img
                              src={p.icon_base64}
                              alt=""
                              className="audio-app-icon-img"
                              style={failedIcons.has(p.icon_base64) ? { display: 'none' } : undefined}
                              onError={() => setFailedIcons(previous => new Set(previous).add(p.icon_base64!))}
                            />
                          ) : p.is_likely_chat_or_voice ? (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                              <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
                            </svg>
                          ) : (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <rect width="18" height="14" x="3" y="5" rx="2" />
                              <path d="M3 9h18" />
                            </svg>
                          )}
                        </div>

                        {/* App info */}
                        <div className="audio-process-details">
                          <div className="audio-process-name-row">
                            <span className="audio-app-name">{p.name}</span>
                            {p.is_likely_chat_or_voice && (
                              <span className="audio-app-tag">{t("message.c9566ca43bdc")}</span>
                            )}
                          </div>
                          <div className="audio-app-window-title">
                            {p.window_title || p.exe_path || t("message.8cadb576e17c")}
                          </div>
                        </div>

                        {/* Standard Checkbox for multi-selection */}
                        <div className="audio-process-toggle-col" onClick={(e) => e.stopPropagation()}>
                          <input autoComplete="off"
                            type="checkbox"
                            className="audio-process-checkbox"
                            checked={isSelected}
                            onChange={(e) => toggleProcess(p, e.target.checked)}
                            aria-label={t("message.d574458ad595", { v0: p.name })}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="modal-footer audio-modal-footer">
          <span className="audio-footer-count">
            {isFullAudio ? t("message.ef4d03545b12") : t('audio.detectedApps', { count: rawProcessCount })}
          </span>
          <div className="audio-footer-buttons">
            <button className="btn btn-secondary" id="btn-cancel-audio-filter" onClick={closeModal}>
              {t("message.bb9dbb406dcb")}</button>
            <button
              className="btn btn-primary"
              id="btn-apply-audio-filter"
              style={{ whiteSpace: 'nowrap' }}
              onClick={handleApply}
            >
              {isFullAudio
                ? t("message.aef7cd5b2081")
                : isExclude
                ? selectedCount === 0
                  ? t("message.aef7cd5b2081")
                  : t("message.01c5f2082214", { v0: selectedCount })
                : selectedCount === 0
                  ? t("message.def57be507c5")
                  : t("message.cc71524f7404", { v0: selectedCount })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
