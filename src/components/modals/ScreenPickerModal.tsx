import { localizeText, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { Select } from '../common/Select';
import React, { useEffect } from 'react';
import { useModal } from '../../hooks/useModal';
import { useScreenPicker } from '../../hooks/useScreenPicker';
import { getSkeletonCountForTab } from './screen_picker_utils';
import { MediaPreview } from '../common/MediaPreview';
import { Camera } from 'lucide-react';
import { formatFrameRate } from '../../core/media_streams';
import { useSkeletonPresence } from '../../hooks/useSkeletonPresence';

export const ScreenPickerModal: React.FC = () => {
  useLocale();
  const { closeModal, isClosing } = useModal();
  const {
    cameras,
    cameraModes,
    cameraRates,
    preview,
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
  } = useScreenPicker(closeModal, isClosing);

  const { displaySkeleton, isFadingOut } = useSkeletonPresence(isLoading);

  useEffect(() => {
    if (!isClosing) void loadSources();
  }, [loadSources, isClosing]);

  const skeletonCount = getSkeletonCountForTab(currentTab === 'cameras' ? 'screens' : currentTab, monitors.length);

  return (
    <div className={`modal-overlay ${isClosing ? 'closing' : ''}`} id="modal-screen-picker">
      <div className="modal-card modal-xl screen-picker-card">
        <div className="modal-header">
          <div className="modal-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect width="20" height="14" x="2" y="3" rx="2"/>
              <line x1="8" x2="16" y1="21" y2="21"/>
              <line x1="12" x2="12" y1="17" y2="21"/>
            </svg>
          </div>
          <div>
            <h2>{editingId ? t("message.eb9fb0e94a23") : t("message.e2deb5c4ba95")}</h2>
            <p className="modal-subtitle">{t("message.83e0034044c4")}</p>
          </div>
          <button className="btn-close" id="btn-close-screen-picker" onClick={closeModal} disabled={isStarting} aria-label={t("message.fe2d6306c0ae")}>
            &times;
          </button>
        </div>

        <div className="modal-body" inert={isStarting || undefined}>

          {error && <p role="alert">{localizeText(error)}</p>}
          <div className="picker-tabs">
            <button
              className={`picker-tab-btn ${currentTab === 'screens' ? 'active' : ''}`}
              id="picker-tab-screens"
              disabled={editingKind === 'camera'}
              onClick={() => setCurrentTab('screens')}
            >
              {t("message.3bd03ac9b6d5")}</button>
            <button
              className={`picker-tab-btn ${currentTab === 'windows' ? 'active' : ''}`}
              id="picker-tab-windows"
              disabled={editingKind === 'camera'}
              onClick={() => setCurrentTab('windows')}
            >
              {t("message.26b90fd75350")}</button>
            {editingKind !== 'screen' && <button className={`picker-tab-btn ${currentTab === 'cameras' ? 'active' : ''}`}
              onClick={() => setCurrentTab('cameras')}>{t("message.de25a5114246")}</button>}
          </div>

          <div className="picker-preview-layout">
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
                {currentTab === 'cameras' && cameras.length === 0 && <div className="source-cards-empty-state">{t("message.f95f9dbef95a")}</div>}
                {currentTab === 'cameras' && cameras.map((camera, index) => <button type="button" key={camera.deviceId || index}
                  className={`source-card ${selectedSourceId === `camera:${camera.deviceId}` ? 'selected' : ''}`}
                  onClick={() => setSelectedSourceId(`camera:${camera.deviceId}`)}>
                  <div className="source-card-thumb camera-device-thumb"><Camera size={28} aria-hidden="true" /></div>
                  <div className="source-card-info"><div className="source-card-title">{camera.label || t("message.6c0ba75d2838", { v0: index + 1 })}</div></div>
                </button>)}
                {currentTab === 'screens' && monitors.length === 0 && (
                  <div className="source-cards-empty-state">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect width="20" height="14" x="2" y="3" rx="2"/>
                      <line x1="8" x2="16" y1="21" y2="21"/>
                      <line x1="12" x2="12" y1="17" y2="21"/>
                    </svg>
                    <span>{t("message.0b7114350c1c")}</span>
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
                          <div className="source-card-thumb-placeholder">{t("common.monitor")}</div>
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
                    <span>{t("message.239f9f8ae9fa")}</span>
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
                          <div className="source-card-thumb-placeholder">{t("message.28014ef35252")}</div>
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

          <MediaPreview stream={preview.stream} sourceKey={selectedSourceId} busy={isLoading || preview.busy} error={preview.error} settings={preview.settings}
            onError={preview.reportPlaybackError} onRetry={preview.retry}
            label={cameras.find((camera) => `camera:${camera.deviceId}` === selectedSourceId)?.label ||
              monitors.find((monitor) => monitor.id === selectedSourceId)?.name ||
              windows.find((window) => window.id === selectedSourceId)?.title || ''} />
          </div>
          <div className="picker-settings-row">
            <div className="picker-setting-item">
              <label htmlFor="modal-select-resolution">{t("message.37f9b18e9942")}</label>
              <Select
                id="modal-select-resolution"
                className="select-input-sm"
                value={resolution}
                onValueChange={(value) => setResolution(value)}
                disabled={currentTab === 'cameras' && (preview.busy || !cameraModes.length)}
                options={currentTab === 'cameras' ? cameraModes : [
                  { value: '4k', label: '4K (3840x2160)' },
                  { value: '1440p', label: '1440p 2K' },
                  { value: '1080p', label: '1080p Full HD' },
                  { value: '720p', label: '720p HD' },
                  { value: '480p', label: '480p SD' },
                  { value: '360p', get label() { return t("message.7e20ddcbeb68"); } },
                ]}
              />
            </div>

            <div className="picker-setting-item">
              <label htmlFor="modal-select-fps">{t("message.d4b20c1d2e76")}</label>
              <Select
                id="modal-select-fps"
                className="select-input-sm"
                value={fps}
                onValueChange={(value) => setFps(Number(value))}
                disabled={currentTab === 'cameras' && (preview.busy || !cameraRates.length)}
                options={currentTab === 'cameras' ? cameraRates.map((rate) => ({ value: String(rate), label: `${formatFrameRate(rate)} FPS` })) : [
                  { value: '120', label: '120 FPS' },
                  { value: '60', label: '60 FPS' },
                  { value: '30', label: '30 FPS' },
                  { value: '15', label: '15 FPS' },
                ]}
              />
            </div>

            <div className="picker-setting-item">
              <label htmlFor="modal-select-bitrate">{t("common.bitrateLabel")}</label>
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
              <label htmlFor="modal-select-quality">{t("message.6b7ea7f227ce")}</label>
              <Select
                id="modal-select-quality"
                className="select-input-sm"
                value={quality}
                onValueChange={(value) => setQuality(parseInt(value, 10))}
                options={[
                  { value: '95', get label() { return t("message.dd41bcf7d5d9"); } },
                  { value: '90', get label() { return t("message.d494620a5da6"); } },
                  { value: '85', get label() { return t("message.0254f0dbf2af"); } },
                  { value: '75', get label() { return t("message.9df00552db6a"); } },
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
              <span>{t("message.3798f7d6d73b")}</span>
            </label>}
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" id="btn-cancel-picker" style={{ width: 'auto' }} onClick={closeModal} disabled={isStarting}>
            {t("message.bb9dbb406dcb")}</button>
          {(() => {
            const hasAvailableSources = currentTab === 'cameras' ? cameras.length > 0 : currentTab === 'screens' ? monitors.length > 0 : windows.length > 0;
            const isConfirmDisabled = isLoading || isStarting || preview.busy || !selectedSourceId || !hasAvailableSources ||
              !preview.stream || !!preview.error ||
              (currentTab === 'cameras' && (!cameraModes.length || !cameraRates.length));
            return (
              <button
                className="btn btn-primary"
                id="btn-confirm-picker"
                style={{ width: 'auto', minWidth: '160px' }}
                disabled={isConfirmDisabled}
                onClick={confirmPicker}
              >
                <span>{isStarting ? t("message.a523b5d5ccb8") : editingId ? t("message.e2162ad991bd") : t("message.fdefcffd1869")}</span>
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
