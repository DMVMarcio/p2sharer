import React, { useEffect } from 'react';
import { useModal } from '../../hooks/useModal';
import { useAudioFilter } from '../../hooks/useAudioFilter';

export const AudioFilterModal: React.FC = () => {
  const { isOpen, closeModal } = useModal();
  const {
    processes,
    isLoading,
    searchText,
    setSearchText,
    selectedFilterMode,
    setFilterMode,
    selectedPids,
    selectedNames,
    toggleProcess,
    loadProcesses,
    applyFilters,
  } = useAudioFilter();

  useEffect(() => {
    if (isOpen('audioFilter')) {
      loadProcesses();
    }
  }, [isOpen, loadProcesses]);

  if (!isOpen('audioFilter')) return null;

  const handleApply = async () => {
    const success = await applyFilters();
    if (success) {
      closeModal();
    }
  };

  return (
    <div className="modal-overlay" id="modal-audio-filter">
      <div className="modal-card modal-lg">
        <div className="modal-header">
          <div className="modal-header-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="2" x2="22" y1="2" y2="22"/>
              <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/>
              <path d="M5 10v2a7 7 0 0 0 12 5"/>
              <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/>
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12"/>
              <line x1="12" x2="12" y1="19" y2="22"/>
            </svg>
          </div>
          <div>
            <h2>Filtro de Áudio por Processo (Windows)</h2>
            <p className="modal-subtitle">
              Escolha quais aplicativos ignorar para que a sua voz/áudio do Discord não vaze na transmissão.
            </p>
          </div>
          <button className="btn-close" id="btn-close-audio-modal" onClick={closeModal}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div className="filter-mode-selector">
            <label className="radio-card">
              <input
                type="radio"
                name="audio-filter-mode"
                value="exclude"
                checked={selectedFilterMode === 'exclude'}
                onChange={() => setFilterMode('exclude')}
              />
              <div className="radio-card-content">
                <strong>Capturar Som do Sistema e Ignorar Selecionados (Recomendado)</strong>
                <span>Captura jogos e sons gerais do computador, silenciando apenas os apps marcados (Discord, etc.).</span>
              </div>
            </label>
            <label className="radio-card">
              <input
                type="radio"
                name="audio-filter-mode"
                value="include"
                checked={selectedFilterMode === 'include'}
                onChange={() => setFilterMode('include')}
              />
              <div className="radio-card-content">
                <strong>Capturar Exclusivamente o Aplicativo Selecionado</strong>
                <span>Captura o áudio apenas do app marcado e silencia todo o restante do Windows.</span>
              </div>
            </label>
          </div>

          <div className="process-filter-controls">
            <input
              type="text"
              id="input-search-process"
              className="text-input"
              placeholder="Filtrar aplicativo (ex: discord, spotify, chrome)..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
            <button className="btn btn-sm btn-outline" id="btn-refresh-processes" onClick={loadProcesses}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
                <path d="M21 3v5h-5"/>
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
                <path d="M8 16H3v5"/>
              </svg>
              <span>Atualizar</span>
            </button>
          </div>

          <div className="process-list-container" id="process-checkboxes-container">
            {isLoading && <div className="loading-state">Atualizando lista de aplicativos...</div>}

            {!isLoading && processes.length === 0 && (
              <div className="loading-state">Nenhum aplicativo correspondente.</div>
            )}

            {!isLoading &&
              processes.map((p) => {
                const nameLower = p.name.toLowerCase();
                const isChecked = selectedPids.has(p.pid) || selectedNames.has(nameLower);

                return (
                  <label key={`${p.pid}_${p.name}`} className="process-item-label">
                    <input
                      type="checkbox"
                      value={p.pid}
                      checked={isChecked}
                      onChange={(e) => toggleProcess(p, e.target.checked)}
                    />
                    <span className="process-name">{p.name}</span>
                    {p.window_title && <span className="process-title">({p.window_title})</span>}
                    <span className="process-pid">PID: {p.pid}</span>
                  </label>
                );
              })}
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" id="btn-cancel-audio-filter" onClick={closeModal}>
            Cancelar
          </button>
          <button className="btn btn-primary" id="btn-apply-audio-filter" onClick={handleApply}>
            Aplicar Filtros de Áudio
          </button>
        </div>
      </div>
    </div>
  );
};
