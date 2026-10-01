import { Select } from '../common/Select';
import React, { useState, useEffect } from 'react';
import { useModal } from '../../hooks/useModal';
import { useScreenPicker } from '../../hooks/useScreenPicker';
import { getSkeletonCountForTab } from './screen_picker_utils';

export const ScreenPickerModal: React.FC = () => {
  const { closeModal, isClosing } = useModal();
  const {
    cameras,
    editingId,
    editingKind,
    error,
    monitors,
    windows,
    currentTab,
    setCurrentTab,
    selectedSourceId,
    setSelectedSourceId,
    isLoading,
    isStarting,
    resolution,
    setResolution,
    fps,
    setFps,
    bitrate,
    setBitrate,
    quality,
    setQuality,
    showCursor,
    setShowCursor,
    loadSources,
    confirmPicker,
  } = useScreenPicker(closeModal);

  const [displaySkeleton, setDisplaySkeleton] = useState(isLoading);
  const [isFadingOut, setIsFadingOut] = useState(false);

  useEffect(() => {
    if (!isClosing) void loadSources();
  }, [loadSources, isClosing]);

  useEffect(() => {
    if (!isLoading && displaySkeleton) {
      setIsFadingOut(true);
      const timer = setTimeout(() => {
        setDisplaySkeleton(false);
        setIsFadingOut(false);
      }, 400);
      return () => clearTimeout(timer);
    } else if (isLoading && !displaySkeleton) {
      setDisplaySkeleton(true);
      setIsFadingOut(false);
    }
  }, [isLoading, displaySkeleton]);

  const skeletonCount = getSkeletonCountForTab(currentTab === 'cameras' ? 'screens' : currentTab, monitors.length);

  return (
    <div className={`modal-overlay ${isClosing ? 'closing' : ''}`} id="modal-screen-picker">
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
            <h2>{editingId ? 'Editar transmissão' : 'Iniciar transmissão'}</h2>
            <p className="modal-subtitle">Escolha uma tela, janela ou câmera.</p>
          </div>
          <button className="btn-close" id="btn-close-screen-picker" onClick={closeModal}>
            &times;
          </button>
        </div>

        <div className="modal-body">

          {error && <p role="alert">{error}</p>}
          <div className="picker-tabs">
            <button
              className={`picker-tab-btn ${currentTab === 'screens' ? 'active' : ''}`}
              id="picker-tab-screens"
              disabled={editingKind === 'camera'}
              onClick={() => setCurrentTab('screens')}
            >
              Telas Inteiras
            </button>
            <button
              className={`picker-tab-btn ${currentTab === 'windows' ? 'active' : ''}`}
              id="picker-tab-windows"
              disabled={editingKind === 'camera'}
              onClick={() => setCurrentTab('windows')}
            >
              Janelas de Apps
            </button>
            <button className={`picker-tab-btn ${currentTab === 'cameras' ? 'active' : ''}`}
              disabled={editingKind === 'screen'}
              onClick={() => setCurrentTab('cameras')}>Câmeras</button>
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
                {currentTab === 'cameras' && cameras.length === 0 && <div className="source-cards-empty-state">Nenhuma câmera detectada.</div>}
                {currentTab === 'cameras' && cameras.map((camera, index) => <button type="button" key={camera.deviceId || index}
                  className={`source-card ${selectedSourceId === `camera:${camera.deviceId}` ? 'selected' : ''}`}
                  onClick={() => setSelectedSourceId(`camera:${camera.deviceId}`)}>
                  <div className="source-card-thumb"><div className="source-card-thumb-placeholder">Câmera</div></div>
                  <div className="source-card-info"><div className="source-card-title">{camera.label || `Câmera ${index + 1}`}</div></div>
                </button>)}
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
              <label htmlFor="modal-select-resolution">Resolução:</label>
              <Select
                id="modal-select-resolution"
                className="select-input-sm"
                value={resolution}
                onValueChange={(value) => setResolution(value)}
                options={[
                  { value: '4k', label: '4K (3840x2160)' },
                  { value: '1440p', label: '1440p 2K' },
                  { value: '1080p', label: '1080p Full HD' },
                  { value: '720p', label: '720p HD' },
                  { value: '480p', label: '480p SD' },
                  { value: '360p', label: '360p Baixa' },
                ]}
              />
            </div>

            <div className="picker-setting-item">
              <label htmlFor="modal-select-fps">Taxa de FPS:</label>
              <Select
                id="modal-select-fps"
                className="select-input-sm"
                value={fps}
                onValueChange={(value) => setFps(parseInt(value, 10))}
                options={[
                  { value: '120', label: '120 FPS' },
                  { value: '60', label: '60 FPS' },
                  { value: '30', label: '30 FPS' },
                  { value: '15', label: '15 FPS' },
                ]}
              />
            </div>

            <div className="picker-setting-item">
              <label htmlFor="modal-select-bitrate">Bitrate:</label>
              <Select
                id="modal-select-bitrate"
                className="select-input-sm"
                value={bitrate}
                onValueChange={(value) => setBitrate(parseInt(value, 10))}
                options={[
                  { value: '35000', label: '35 Mbps' },
                  { value: '25000', label: '25 Mbps' },
                  { value: '15000', label: '15 Mbps' },
                  { value: '8000', label: '8 Mbps' },
                  { value: '3000', label: '3 Mbps' },
                  { value: '1000', label: '1 Mbps' },
                ]}
              />
            </div>

            {currentTab !== 'cameras' && <div className="picker-setting-item">
              <label htmlFor="modal-select-quality">Qualidade:</label>
              <Select
                id="modal-select-quality"
                className="select-input-sm"
                value={quality}
                onValueChange={(value) => setQuality(parseInt(value, 10))}
                options={[
                  { value: '95', label: '95% (Máxima)' },
                  { value: '90', label: '90% (Muito Alta)' },
                  { value: '85', label: '85% (Alta)' },
                  { value: '75', label: '75% (Equilibrada)' },
                ]}
              />
            </div>}

            {currentTab !== 'cameras' && <label className="picker-checkbox-label">
              <input autoComplete="off"
                type="checkbox"
                id="modal-check-cursor"
                checked={showCursor}
                onChange={(e) => setShowCursor(e.target.checked)}
              />
              <span>Exibir Cursor</span>
            </label>}
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" id="btn-cancel-picker" style={{ width: 'auto' }} onClick={closeModal}>
            Cancelar
          </button>
          {(() => {
            const hasAvailableSources = currentTab === 'cameras' ? cameras.length > 0 : currentTab === 'screens' ? monitors.length > 0 : windows.length > 0;
            const isConfirmDisabled = isLoading || isStarting || !selectedSourceId || !hasAvailableSources;
            return (
              <button
                className="btn btn-primary"
                id="btn-confirm-picker"
                style={{ width: 'auto', minWidth: '160px' }}
                disabled={isConfirmDisabled}
                onClick={confirmPicker}
              >
                <span>{isStarting ? 'Aplicando...' : editingId ? 'Aplicar alterações' : 'Iniciar Transmissão'}</span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
              </button>
            );
          })()}
        </div>
      </div>
    </div>
  );
};
