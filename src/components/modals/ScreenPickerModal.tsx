import React, { useState, useEffect } from 'react';
import { useModal } from '../../hooks/useModal';
import { useScreenPicker } from '../../hooks/useScreenPicker';
import { getSkeletonCountForTab } from './screen_picker_utils';

export const ScreenPickerModal: React.FC = () => {
  const { closeModal } = useModal();
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
  } = useScreenPicker(closeModal);

  const [displaySkeleton, setDisplaySkeleton] = useState(isLoading);
  const [isFadingOut, setIsFadingOut] = useState(false);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  useEffect(() => {
    if (!isLoading && displaySkeleton) {
      setIsFadingOut(true);
      const timer = setTimeout(() => {
        setDisplaySkeleton(false);
        setIsFadingOut(false);
      }, 200);
      return () => clearTimeout(timer);
    } else if (isLoading && !displaySkeleton) {
      setDisplaySkeleton(true);
      setIsFadingOut(false);
    }
  }, [isLoading, displaySkeleton]);

  const skeletonCount = getSkeletonCountForTab(currentTab, monitors.length);

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
            <p className="modal-subtitle">Escolha uma tela inteira ou janela para transmitir.</p>
          </div>
          <button className="btn-close" id="btn-close-screen-picker" onClick={closeModal}>
            &times;
          </button>
        </div>

        <div className="modal-body">

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

          <div className="picker-sources-container-wrapper" id="picker-sources-container">
            {displaySkeleton && (
              <div
                className={`source-cards-grid source-cards-skeleton-layer ${isFadingOut ? 'fade-out' : ''}`}
                aria-hidden="true"
              >
                {Array.from({ length: skeletonCount }).map((_, idx) => (
                  <div
                    key={`source-skeleton-${idx}`}
                    className="source-card source-card-skeleton"
                    data-testid="source-card-skeleton"
                    aria-hidden="true"
                  >
                    <div className="source-card-thumb skeleton-shimmer">
                      <div className="source-card-thumb-skeleton-icon">
                        {currentTab === 'screens' ? (
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <rect width="20" height="14" x="2" y="3" rx="2"/>
                            <line x1="8" x2="16" y1="21" y2="21"/>
                            <line x1="12" x2="12" y1="17" y2="21"/>
                          </svg>
                        ) : (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <rect width="18" height="18" x="3" y="3" rx="2"/>
                            <line x1="3" x2="21" y1="9" y2="9"/>
                            <line x1="9" x2="21" y2="9"/>
                          </svg>
                        )}
                      </div>
                    </div>
                    <div className="source-card-info">
                      <div className="skeleton-line skeleton-title-line skeleton-shimmer"></div>
                      <div className="skeleton-line skeleton-sub-line skeleton-shimmer"></div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!isLoading && (
              <div className="source-cards-grid source-cards-content-layer">
                {currentTab === 'screens' && monitors.length === 0 && (
                  <div className="source-cards-empty-state">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect width="20" height="14" x="2" y="3" rx="2"/>
                      <line x1="8" x2="16" y1="21" y2="21"/>
                      <line x1="12" x2="12" y1="17" y2="21"/>
                    </svg>
                    <span>Nenhum monitor detectado.</span>
                  </div>
                )}

                {currentTab === 'screens' && monitors.map((mon) => {
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

                {currentTab === 'windows' && windows.length === 0 && (
                  <div className="source-cards-empty-state">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect width="18" height="18" x="3" y="3" rx="2"/>
                      <line x1="3" x2="21" y1="9" y2="9"/>
                      <line x1="9" x2="21" y2="9"/>
                    </svg>
                    <span>Nenhuma janela aberta encontrada.</span>
                  </div>
                )}

                {currentTab === 'windows' && windows.map((win) => {
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
            )}
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
            style={{ width: 'auto', minWidth: '160px' }}
            disabled={isLoading || (!selectedSourceId && (currentTab === 'screens' ? monitors.length === 0 : windows.length === 0))}
            onClick={confirmPicker}
          >
            <span>Iniciar Transmissão</span>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};
