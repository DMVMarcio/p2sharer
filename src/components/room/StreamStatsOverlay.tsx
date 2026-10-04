import { getLanguage, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React from 'react';
import type { StreamWatcher } from '../../core/types';
import { Tooltip } from '../common/Tooltip';
import { WatchersTooltipContent } from './WatchersTooltipContent';

interface StreamStatsOverlayProps {
  qualityText: string;
  liveBitrateKbps: number;
  configuredBitrateKbps: number;
  isLocal: boolean;
  pingText?: string;
  pingClass?: 'ping-good' | 'ping-medium' | 'ping-poor';
  transportTag?: string;
  watchers: StreamWatcher[];
  onTooltipOpenChange?: (open: boolean) => void;
  className?: string;
}

export const StreamStatsOverlay: React.FC<StreamStatsOverlayProps> = ({
  qualityText,
  liveBitrateKbps,
  configuredBitrateKbps,
  isLocal,
  pingText,
  pingClass,
  transportTag = '',
  watchers,
  onTooltipOpenChange,
  className = '',
}) => {
  useLocale();
  const liveBitrateText = `${(liveBitrateKbps / 1000).toLocaleString(getLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} Mbps`;
  const configuredBitrateValue = (configuredBitrateKbps / 1000).toLocaleString(getLanguage(), { maximumFractionDigits: 0 });
  const configuredBitrateText = `${configuredBitrateValue} Mbps`;

  const bitrateTooltip = liveBitrateKbps > 0 ? (
    <>
      <div className="bitrate-tooltip-header">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
        <span>{isLocal ? t("message.0e707dbd2e4f") : t("message.7586f42ba904")}</span>
      </div>
      <div className="bitrate-tooltip-content">
        <div className="bitrate-tooltip-row">
          <span className="bitrate-tooltip-label">{t("message.c5bbb45a7b72")}</span>
          <span className="bitrate-tooltip-value">{liveBitrateText}</span>
        </div>
        {isLocal && (
          <div className="bitrate-tooltip-row">
            <span className="bitrate-tooltip-label">{t("message.df6187a94e2c")}</span>
            <span className="bitrate-tooltip-value">{configuredBitrateText}</span>
          </div>
        )}
      </div>
    </>
  ) : isLocal ? (
    <>
      <div className="bitrate-tooltip-header">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
        <span>{t("message.0e707dbd2e4f")}</span>
      </div>
      <div className="bitrate-tooltip-content">
        <div className="bitrate-tooltip-row">
          <span className="bitrate-tooltip-label">{t("message.df6187a94e2c")}</span>
          <span className="bitrate-tooltip-value">{configuredBitrateText}</span>
        </div>
        <div className="bitrate-tooltip-hint">{t("message.2801c6d2c8eb")}</div>
      </div>
    </>
  ) : (
    <>
      <div className="bitrate-tooltip-header">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
        <span>{t("message.7586f42ba904")}</span>
      </div>
      <div className="bitrate-tooltip-content">
        <div className="bitrate-tooltip-row">
          <span className="bitrate-tooltip-label">{t("message.c5bbb45a7b72")}</span>
          <span className="bitrate-tooltip-value">{liveBitrateText}</span>
        </div>
        <div className="bitrate-tooltip-hint">{t("message.608b5b61bfcb")}</div>
      </div>
    </>
  );

  return (
    <div className={`stream-card-stats-hud ${className}`.trim()}>
      <span className="stat-badge stat-badge-quality">
        <span className="stat-badge-dot" />
        <span className="stat-quality-text">{qualityText}</span>
      </span>

      <Tooltip tooltipClassName="bitrate-tooltip" onOpenChange={onTooltipOpenChange} content={bitrateTooltip}>
        <div className="stat-badge stat-badge-bitrate" onClick={(event) => event.stopPropagation()}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          <span className="stat-bitrate-text">
            {liveBitrateKbps > 0 ? liveBitrateText : isLocal ? t("message.13028932018d", { v0: configuredBitrateValue }) : liveBitrateText}
          </span>
        </div>
      </Tooltip>

      {!isLocal && pingText && pingClass && (
        <span className="stat-badge stat-badge-ping">
          <span className={`stat-ping-dot ${pingClass}`} />
          <span className="stat-ping-text">{pingText}{transportTag}</span>
        </span>
      )}

      <Tooltip
        interactive
        tooltipClassName="watchers-tooltip"
        onOpenChange={onTooltipOpenChange}
        content={<WatchersTooltipContent watchers={watchers} />}
      >
        <button type="button" className="stat-badge stat-badge-watchers" aria-label={t("message.0b8f4ee757ab")} onClick={(event) => event.stopPropagation()}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span className="stat-watchers-text">
            {watchers.length === 1 ? t("message.9c8593585d9a") : t("message.338e7425455d", { v0: watchers.length })}
          </span>
        </button>
      </Tooltip>
    </div>
  );
};
