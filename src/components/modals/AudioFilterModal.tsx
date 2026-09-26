import React, { useEffect } from 'react';
import { useModal } from '../../hooks/useModal';
import { useAudioFilter } from '../../hooks/useAudioFilter';
import { Tooltip } from '../common/Tooltip';

export const AudioFilterModal: React.FC = () => {
  const { closeModal } = useModal();
  const {
    processes,
    rawProcessCount,
    isLoading,
    searchText,
    setSearchText,
    selectedFilterMode,
    setFilterMode,
    selectedNames,
    toggleProcess,
    selectSingleProcess,
    selectVoiceApps,
    clearSelection,
    loadProcesses,
    applyFilters,
  } = useAudioFilter();

  useEffect(() => {
    loadProcesses();
  }, [loadProcesses]);

  const handleApply = async () => {
    const success = await applyFilters();
    if (success) {
      closeModal();
    }
  };

  const isExclude = selectedFilterMode === 'exclude';
  const selectedCount = selectedNames.size;

  return (
    <div className="modal-overlay" id="modal-audio-filter">
      <div className="modal-card modal-lg audio-filter-modal-card">
        {/* Modal Header */}
        <div className="modal-header">
          <div className="modal-header-icon audio-modal-icon-badge">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" x2="12" y1="19" y2="22" />
            </svg>
          </div>
          <div>
            <h2>Filtro de Áudio do Sistema</h2>
            <p className="modal-subtitle">
              Escolha exatamente quais sons e aplicativos compartilhar ou silenciar na transmissão.
            </p>
          </div>
          <button className="btn-close" id="btn-close-audio-modal" onClick={closeModal} aria-label="Fechar">
            &times;
          </button>
        </div>

        <div className="modal-body audio-filter-modal-body">
          {/* Mode Selector Cards */}
          <div className="audio-mode-selector-grid" role="radiogroup" aria-label="Modo de filtro de áudio">
            {/* Exclude Mode Card */}
            <div
              className={`audio-mode-card ${isExclude ? 'active' : ''}`}
              onClick={() => setFilterMode('exclude')}
              role="radio"
              aria-checked={isExclude}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setFilterMode('exclude');
                }
              }}
            >
              <div className="audio-mode-card-header">
                <div className="audio-mode-icon-circle exclude">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="1" x2="23" y1="1" y2="23" />
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                    <line x1="12" x2="12" y1="19" y2="23" />
                    <line x1="8" x2="16" y1="23" y2="23" />
                  </svg>
                </div>
                <div className="audio-mode-titles">
                  <div className="audio-mode-title-row">
                    <span className="audio-mode-title">Silenciar Aplicativos</span>
                    <span className="audio-mode-badge recommended">Recomendado</span>
                  </div>
                  <span className="audio-mode-desc">
                    Transmite o computador (jogos, vídeos), silenciando apenas os apps marcados (ex: Discord).
                  </span>
                </div>
              </div>
            </div>

            {/* Include Mode Card */}
            <div
              className={`audio-mode-card ${!isExclude ? 'active' : ''}`}
              onClick={() => setFilterMode('include')}
              role="radio"
              aria-checked={!isExclude}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setFilterMode('include');
                }
              }}
            >
              <div className="audio-mode-card-header">
                <div className="audio-mode-icon-circle include">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <circle cx="12" cy="12" r="6" />
                    <circle cx="12" cy="12" r="2" />
                  </svg>
                </div>
                <div className="audio-mode-titles">
                  <div className="audio-mode-title-row">
                    <span className="audio-mode-title">Transmitir Apenas Um App</span>
                    <span className="audio-mode-badge focus">Foco</span>
                  </div>
                  <span className="audio-mode-desc">
                    Transmite com exclusividade o som do aplicativo escolhido e silencia o restante do PC.
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Dynamic Status Banner */}
          <div className={`audio-status-banner ${isExclude ? (selectedCount === 0 ? 'full-audio' : 'filtering') : (selectedCount > 0 ? 'focus-active' : 'focus-empty')}`}>
            {isExclude && selectedCount === 0 && (
              <>
                <span className="audio-status-dot active-green" />
                <div className="audio-status-text">
                  <strong>Transmitindo Todo o Computador:</strong> Nenhum aplicativo silenciado. Qualquer áudio reproduzido no Windows será compartilhado.
                </div>
              </>
            )}

            {isExclude && selectedCount > 0 && (
              <>
                <span className="audio-status-dot active-warn" />
                <div className="audio-status-text">
                  <strong>Silenciando {selectedCount} aplicativo(s):</strong> O áudio destes aplicativos não vazará na transmissão.
                </div>
              </>
            )}

            {!isExclude && selectedCount > 0 && (
              <>
                <span className="audio-status-dot active-cyan" />
                <div className="audio-status-text">
                  <strong>Foco Exclusivo Ativo:</strong> Transmitindo apenas o som de <em>{Array.from(selectedNames)[0]}</em>. Todo o restante do sistema está mudo.
                </div>
              </>
            )}

            {!isExclude && selectedCount === 0 && (
              <>
                <span className="audio-status-dot active-neutral" />
                <div className="audio-status-text">
                  <strong>Nenhum aplicativo focado:</strong> Selecione um aplicativo na lista abaixo para transmitir seu áudio com exclusividade.
                </div>
              </>
            )}
          </div>

          {/* Action Toolbar */}
          <div className="audio-filter-toolbar">
            <div className="audio-search-input-wrapper">
              <svg className="audio-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                id="input-search-process"
                className="audio-search-input"
                placeholder="Pesquisar por nome ou janela..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
              />
              {searchText && (
                <button
                  type="button"
                  className="audio-search-clear-btn"
                  onClick={() => setSearchText('')}
                  aria-label="Limpar busca"
                >
                  &times;
                </button>
              )}
            </div>

            <div className="audio-toolbar-actions">
              {isExclude && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost audio-quick-action-btn"
                  onClick={selectVoiceApps}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                  <span>Silenciar Chamadas</span>
                </button>
              )}

              {selectedCount > 0 && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost audio-quick-action-btn"
                  onClick={clearSelection}
                >
                  <span>Limpar</span>
                </button>
              )}

              <Tooltip content="Atualizar lista de aplicativos abertos">
                <button
                  type="button"
                  className={`btn btn-sm btn-outline audio-refresh-btn ${isLoading ? 'spinning' : ''}`}
                  onClick={loadProcesses}
                  aria-label="Atualizar lista de aplicativos"
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
                <span>Atualizando aplicativos em execução...</span>
              </div>
            )}

            {!isLoading && processes.length === 0 && (
              <div className="audio-empty-state">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <span>Nenhum aplicativo correspondente a &quot;{searchText}&quot;</span>
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
                    onClick={() => {
                      if (isExclude) {
                        toggleProcess(p, !isSelected);
                      } else {
                        selectSingleProcess(p);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (isExclude) {
                          toggleProcess(p, !isSelected);
                        } else {
                          selectSingleProcess(p);
                        }
                      }
                    }}
                  >
                    {/* Process Icon */}
                    <div className={`audio-process-icon-box ${p.is_likely_chat_or_voice ? 'voice' : 'window'}`}>
                      {p.is_likely_chat_or_voice ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                          <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
                          <span className="audio-app-tag voice">Voz / Chamada</span>
                        )}
                        {p.window_title && !p.is_likely_chat_or_voice && (
                          <span className="audio-app-tag window">Janela Ativa</span>
                        )}
                      </div>
                      {p.window_title && (
                        <div className="audio-app-window-title">{p.window_title}</div>
                      )}
                    </div>

                    {/* Toggle Control: Checkbox for exclude, Radio circle for include */}
                    <div className="audio-process-toggle-col" onClick={(e) => e.stopPropagation()}>
                      {isExclude ? (
                        <input
                          type="checkbox"
                          className="audio-process-checkbox"
                          checked={isSelected}
                          onChange={(e) => toggleProcess(p, e.target.checked)}
                          aria-label={`Silenciar ${p.name}`}
                        />
                      ) : (
                        <input
                          type="radio"
                          name="audio-include-single-process"
                          className="audio-process-radio"
                          checked={isSelected}
                          onChange={() => selectSingleProcess(p)}
                          aria-label={`Transmitir exclusivamente ${p.name}`}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
          </div>

          <div className="audio-process-footer-hint">
            <span>
              {rawProcessCount} aplicativo(s) detectado(s) no sistema.{' '}
              {isExclude
                ? 'Marque os apps que deseja ignorar.'
                : 'Selecione um único app para focar seu áudio.'}
            </span>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="modal-footer audio-modal-footer">
          <button className="btn btn-secondary" id="btn-cancel-audio-filter" onClick={closeModal}>
            Cancelar
          </button>
          <button className="btn btn-primary" id="btn-apply-audio-filter" onClick={handleApply}>
            {isExclude
              ? selectedCount === 0
                ? 'Salvar (Transmitir Tudo)'
                : `Silenciar Selecionados (${selectedCount})`
              : selectedCount === 0
                ? 'Salvar'
                : `Transmitir Exclusivo (${selectedCount})`}
          </button>
        </div>
      </div>
    </div>
  );
};
