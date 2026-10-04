import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React from 'react';
import { MIN_ZOOM, MAX_ZOOM } from './zoom_utils';

interface ZoomControlBarProps {
  zoom: number;
  onZoomChange: (newZoom: number) => void;
  onStepZoom: (direction: 1 | -1) => void;
  onResetZoom: () => void;
  hasVolumeControl?: boolean;
}

export const ZoomControlBar: React.FC<ZoomControlBarProps> = ({
  zoom,
  onZoomChange,
  onStepZoom,
  onResetZoom,
  hasVolumeControl = false,
}) => {
  useLocale();
  if (zoom <= 1.0) return null;

  const percentage = Math.round(zoom * 100);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const val = parseFloat(e.target.value);
    onZoomChange(val / 100);
  };

  return (
    <div
      className={`stream-zoom-bar ${hasVolumeControl ? 'has-volume' : ''}`}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Zoom Icon */}
      <span className="stream-zoom-icon">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
          <line x1="11" y1="8" x2="11" y2="14" />
          <line x1="8" y1="11" x2="14" y2="11" />
        </svg>
      </span>

      {/* Decrement Button (-) */}
      <button
        type="button"
        className="btn-zoom-step btn-zoom-out"
        aria-label={t("message.9eee5c2ade4f")}
        disabled={zoom <= MIN_ZOOM}
        onClick={(e) => {
          e.stopPropagation();
          onStepZoom(-1);
        }}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      {/* Precision Slider */}
      <div className="stream-zoom-slider-container">
        <input autoComplete="off"
          type="range"
          min={MIN_ZOOM * 100}
          max={MAX_ZOOM * 100}
          step={5}
          value={percentage}
          className="stream-zoom-range"
          onChange={handleSliderChange}
          aria-label={t("message.000b55422207")}
        />
      </div>

      {/* Increment Button (+) */}
      <button
        type="button"
        className="btn-zoom-step btn-zoom-in"
        aria-label={t("message.a06a53fcef5d")}
        disabled={zoom >= MAX_ZOOM}
        onClick={(e) => {
          e.stopPropagation();
          onStepZoom(1);
        }}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      {/* Percentage Readout Badge */}
      <span className="stream-zoom-badge">
        {percentage}%
      </span>

      {/* Reset Zoom Button */}
      <button
        type="button"
        className="btn-zoom-reset"
        aria-label={t("message.94e1172eb769")}
        onClick={(e) => {
          e.stopPropagation();
          onResetZoom();
        }}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
        <span>{t("common.reset")}</span>
      </button>
    </div>
  );
};
