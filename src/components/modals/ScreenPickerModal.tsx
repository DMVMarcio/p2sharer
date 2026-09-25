import React, { useEffect } from 'react';
import { useModal } from '../../hooks/useModal';
import { useScreenPicker } from '../../hooks/useScreenPicker';

export const ScreenPickerModal: React.FC = () => {
  const { isOpen, closeModal } = useModal();
  const {
    monitors,
    windows,
    currentTab,
    setCurrentTab,
    selectedSourceId,
    setSelectedSourceId,
    isLoading,
    resolution,
    setResolution,
    fps,
    setFps,
    bitrate,
    setBitrate,
    showCursor,
    setShowCursor,
    loadSources,
    confirmPicker,
    startDirectGpu,
  } = useScreenPicker(closeModal);

  useEffect(() => {
    if (isOpen('screenPicker')) {
      loadSources();
    }
  }, [isOpen, loadSources]);

  if (!isOpen('screenPicker')) return null;

  return (
    <div className="modal-overlay" id="modal-screen-picker">
      <div className="modal-card modal-xl">
        <div className="modal-header">
          <div className="modal-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect width="20" height="14" x="2" y="3" rx="2"/>
              <line x1="8" x2="16" y1="21" y2="21"/>
              <line x1="12" x2="12" y1="17" y2="21"/>
            </svg>
          </div>
          <div>
            <h2>Compartilhar Tela</h2>
            <p className="modal-subtitle">Escolha um monitor ou janela de aplicativo para transmitir ao vivo.</p>
          </div>
          <button className="btn-close" id="btn-close-screen-picker" onClick={closeModal}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          {/* Prominent Direct GPU Mode Banner */}
          <div
            className="direct-gpu-card"
            id="card-direct-gpu-capture"
            role="button"
            tabIndex={0}
            title="Iniciar captura acelerada diretamente pela GPU (Zero Cópia)"
            onClick={startDirectGpu}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                startDirectGpu();
              }
            }}
          >
            <div className="direct-gpu-icon-badge">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" fillOpacity="0.2"/>
              </svg>
            </div>
            <div className="direct-gpu-text">
              <div className="direct-gpu-header">
                <span className="direct-gpu-title">Captura Direta GPU (Tela Cheia 60 FPS - Zero Cópia)</span>
                <span className="direct-gpu-badge">Aceleração Máxima</span>
              </div>
              <div className="direct-gpu-desc">
                Captura direta via DirectX / Chromium GPU Pipeline com codificação de hardware NVENC/QSV/VCN. Zero sobrecarga de CPU, ideal para jogos e transmissões de alta taxa de quadros.
              </div>
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm direct-gpu-btn"
              id="btn-start-direct-gpu"
              onClick={(e) => {
                e.stopPropagation();
                startDirectGpu();
              }}
            >
              <span>Iniciar GPU Direta</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            </button>
          </div>

          <div className="picker-tabs">
            <button
              className={`picker-tab-btn ${currentTab === 'screens' ? 'active' : ''}`}
              id="picker-tab-screens"
              onClick={() => setCurrentTab('screens')}
            >
              Telas Inteiras
            </button>
            <button
              className={`picker-tab-btn ${currentTab === 'windows' ? 'active' : ''}`}
              id="picker-tab-windows"
              onClick={() => setCurrentTab('windows')}
            >
              Janelas de Apps
            </button>
          </div>

          <div className="source-cards-grid" id="picker-sources-container">
            {isLoading && <div className="loading-state">Detectando telas e janelas ativas...</div>}

            {!isLoading && currentTab === 'screens' && monitors.length === 0 && (
              <div className="loading-state">Nenhum monitor detectado.</div>
            )}

            {!isLoading && currentTab === 'screens' && monitors.map((mon) => {
              const isSelected = selectedSourceId === mon.id;
              return (
                <div
                  key={mon.id}
                  className={`source-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => setSelectedSourceId(mon.id)}
                >
                  <div className="source-card-thumb">
                    {mon.thumbnail ? (
                      <img src={mon.thumbnail} alt={mon.name} />
                    ) : (
                      <div className="source-card-thumb-placeholder">Monitor</div>
                    )}
                  </div>
                  <div className="source-card-info">
                    <div className="source-card-title">{mon.name}</div>
                    <div className="source-card-subtitle">{mon.width}x{mon.height}</div>
                  </div>
                </div>
              );
            })}

            {!isLoading && currentTab === 'windows' && windows.length === 0 && (
              <div className="loading-state">Nenhuma janela aberta encontrada.</div>
            )}

            {!isLoading && currentTab === 'windows' && windows.map((win) => {
              const isSelected = selectedSourceId === win.id;
              return (
                <div
                  key={win.id}
                  className={`source-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => setSelectedSourceId(win.id)}
                >
                  <div className="source-card-thumb">
                    {win.thumbnail ? (
                      <img src={win.thumbnail} alt={win.title} />
                    ) : (
                      <div className="source-card-thumb-placeholder">Janela</div>
                    )}
                  </div>
                  <div className="source-card-info">
                    <div className="source-card-title">{win.title || win.process_name}</div>
                    <div className="source-card-subtitle">{win.process_name}</div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="picker-settings-row">
            <div className="picker-setting-item">
              <label>Resolução:</label>
              <select
                id="modal-select-resolution"
                className="select-input-sm"
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
              >
                <option value="4k">4K (3840x2160)</option>
                <option value="1440p">1440p 2K</option>
                <option value="1080p">1080p Full HD</option>
                <option value="720p">720p HD</option>
                <option value="480p">480p SD</option>
                <option value="360p">360p Baixa</option>
              </select>
            </div>

            <div className="picker-setting-item">
              <label>Taxa de FPS:</label>
              <select
                id="modal-select-fps"
                className="select-input-sm"
                value={fps}
                onChange={(e) => setFps(parseInt(e.target.value, 10))}
              >
                <option value={120}>120 FPS</option>
                <option value={60}>60 FPS</option>
                <option value={30}>30 FPS</option>
                <option value={15}>15 FPS</option>
              </select>
            </div>

            <div className="picker-setting-item">
              <label>Bitrate:</label>
              <select
                id="modal-select-bitrate"
                className="select-input-sm"
                value={bitrate}
                onChange={(e) => setBitrate(parseInt(e.target.value, 10))}
              >
                <option value={35000}>35 Mbps</option>
                <option value={25000}>25 Mbps</option>
                <option value={15000}>15 Mbps</option>
                <option value={8000}>8 Mbps</option>
                <option value={3000}>3 Mbps</option>
                <option value={1000}>1 Mbps</option>
              </select>
            </div>

            <label className="picker-checkbox-label">
              <input
                type="checkbox"
                id="modal-check-cursor"
                checked={showCursor}
                onChange={(e) => setShowCursor(e.target.checked)}
              />
              <span>Exibir Cursor</span>
            </label>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" id="btn-cancel-picker" style={{ width: 'auto' }} onClick={closeModal}>
            Cancelar
          </button>
          <button
            className="btn btn-primary"
            id="btn-confirm-picker"
            style={{ width: 'auto', minWidth: '140px' }}
            onClick={confirmPicker}
          >
            <span>Transmitir Ao Vivo</span>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};
