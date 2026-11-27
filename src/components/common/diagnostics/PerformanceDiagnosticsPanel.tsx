import React, { useState, useCallback, useRef, useEffect } from 'react';
import { t } from '../../../i18n/index.ts';
import { useLocale } from '../../../hooks/useLocale.ts';
import { showToast } from '../../../hooks/useToast.ts';
import {
  exportPerformanceReportFile,
  runPerformanceDiagnostics,
  type PerformanceDiagnosticProgress,
  type PerformanceDiagnosticReport,
} from '../../../services/performance_diagnostics.ts';

const DEFAULT_DURATION_MS = 10_000;

export const PerformanceDiagnosticsPanel: React.FC = () => {
  useLocale();
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<PerformanceDiagnosticProgress | null>(null);
  const [result, setResult] = useState<PerformanceDiagnosticReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleRun = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setIsRunning(true);
    setError(null);
    setProgress({ elapsedMs: 0, targetMs: DEFAULT_DURATION_MS, latestTick: null });
    try {
      const report = await runPerformanceDiagnostics({
        durationMs: DEFAULT_DURATION_MS,
        signal: controller.signal,
        onProgress: (p) => setProgress(p),
      });
      setResult(report);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortRef.current = null;
      setIsRunning(false);
    }
  }, []);

  const handleStopEarly = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleCopyReport = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.rawJson);
      showToast(t('performance.diagnostics.reportCopied'), 3000, 'success');
    } catch {
      showToast(t('performance.diagnostics.copyFailed'), 3000, 'error');
    }
  }, [result]);

  const handleExportReport = useCallback(async () => {
    if (!result) return;
    try {
      const savedPath = await exportPerformanceReportFile(result);
      if (savedPath) {
        showToast(t('performance.diagnostics.reportExported'), 3500, 'success');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 3500, 'error');
    }
  }, [result]);

  const remainingSeconds = progress
    ? Math.max(0, Math.ceil((progress.targetMs - progress.elapsedMs) / 1000))
    : Math.ceil(DEFAULT_DURATION_MS / 1000);

  const nativeSummary = result?.native?.summary ?? null;
  const rendererCpu =
    result?.native?.webview2_by_role.find((r) => r.role === 'webview2-renderer')?.cpu_pct_total ?? 0;
  const gpuCpu =
    result?.native?.webview2_by_role.find((r) => r.role === 'webview2-gpu')?.cpu_pct_total ?? 0;

  const badgeForCpu = (pct: number) =>
    pct >= 20 ? 'badge-blocked' : pct >= 10 ? 'badge-amber' : 'badge-green';

  const adviceMessage = result
    ? result.analysis.primaryBottleneck === 'software-rendering'
      ? t('performance.diagnostics.adviceSoftware')
      : result.analysis.primaryBottleneck === 'native'
      ? t('performance.diagnostics.adviceNative')
      : result.analysis.primaryBottleneck === 'webview-gpu'
      ? t('performance.diagnostics.adviceWebviewGpu')
      : result.analysis.primaryBottleneck === 'webrtc-software'
      ? t('performance.diagnostics.adviceWebrtcSoftware')
      : result.analysis.primaryBottleneck === 'webview-renderer'
      ? t('performance.diagnostics.adviceWebviewRenderer')
      : result.analysis.severity === 'optimal'
      ? t('performance.diagnostics.adviceOptimal')
      : t('performance.diagnostics.adviceModerate')
    : '';

  return (
    <div className="network-diagnostics-container" id="performance-diagnostics-section">
      <div className="settings-pane-header rendezvous-header">
        <h3 className="settings-pane-title">{t('performance.diagnostics.title')}</h3>
        <p className="settings-pane-desc">{t('performance.diagnostics.desc')}</p>
      </div>

      <div className="network-diagnostics-actions" style={{ flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-sm btn-outline network-diagnostics-btn"
          onClick={isRunning ? handleStopEarly : handleRun}
        >
          {isRunning ? (
            <>
              <svg className="spinner-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="12" />
              </svg>
              <span>{t('performance.diagnostics.running', { seconds: remainingSeconds })}</span>
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
              <span>{t('performance.diagnostics.run')}</span>
            </>
          )}
        </button>

        {result && !isRunning && (
          <>
            <button
              type="button"
              className="btn btn-sm btn-primary network-diagnostics-btn"
              onClick={handleExportReport}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>{t('performance.diagnostics.exportJson')}</span>
            </button>

            <button
              type="button"
              className="btn btn-sm btn-outline network-diagnostics-btn"
              onClick={handleCopyReport}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span>{t('performance.diagnostics.copyReport')}</span>
            </button>
          </>
        )}
      </div>

      {isRunning && progress?.latestTick && (
        <div className="diagnostics-advice-box advice-moderate">
          <p className="diagnostics-advice-text">
            {t('performance.diagnostics.liveSample', {
              total: progress.latestTick.combined_cpu_pct.toFixed(1),
              native: progress.latestTick.p2sharer_cpu_pct.toFixed(1),
              webview: progress.latestTick.webview2_cpu_pct.toFixed(1),
            })}
          </p>
        </div>
      )}

      {error && (
        <div className="network-diagnostics-error">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className={`network-diagnostics-card result-${result.analysis.severity}`}>
          <div className="diagnostics-metric-grid">
            {/* Metric 1: Native Process CPU */}
            <div className="diagnostics-metric-item">
              <span className="diagnostics-metric-label">{t('performance.diagnostics.nativeCpu')}</span>
              <div className="diagnostics-metric-value-row">
                {nativeSummary ? (
                  <>
                    <span className={`diagnostics-badge ${badgeForCpu(nativeSummary.p2sharer_avg_cpu_pct)}`}>
                      {nativeSummary.p2sharer_avg_cpu_pct.toFixed(1)}%
                    </span>
                    <span className="diagnostics-latency">
                      {t('performance.diagnostics.peakAndRam', {
                        peak: nativeSummary.p2sharer_peak_cpu_pct.toFixed(1),
                        ram: Math.round(nativeSummary.p2sharer_working_set_mb),
                      })}
                    </span>
                  </>
                ) : (
                  <span className="diagnostics-badge badge-muted">—</span>
                )}
              </div>
            </div>

            {/* Metric 2: WebView2 CPU */}
            <div className="diagnostics-metric-item">
              <span className="diagnostics-metric-label">{t('performance.diagnostics.webviewCpu')}</span>
              <div className="diagnostics-metric-value-row">
                {nativeSummary ? (
                  <>
                    <span className={`diagnostics-badge ${badgeForCpu(nativeSummary.webview2_avg_cpu_pct)}`}>
                      {nativeSummary.webview2_avg_cpu_pct.toFixed(1)}%
                    </span>
                    <span className="diagnostics-latency">
                      R {rendererCpu.toFixed(1)}% · GPU {gpuCpu.toFixed(1)}% · {Math.round(nativeSummary.webview2_working_set_mb)} MB
                    </span>
                  </>
                ) : (
                  <span className="diagnostics-badge badge-muted">—</span>
                )}
              </div>
            </div>

            {/* Metric 3: UI Responsiveness */}
            <div className="diagnostics-metric-item">
              <span className="diagnostics-metric-label">{t('performance.diagnostics.uiResponsiveness')}</span>
              <div className="diagnostics-metric-value-row">
                <span
                  className={`diagnostics-badge ${
                    result.frontend.uiFrames.avgFps >= 50
                      ? 'badge-green'
                      : result.frontend.uiFrames.avgFps >= 30
                      ? 'badge-amber'
                      : 'badge-blocked'
                  }`}
                >
                  {result.frontend.uiFrames.avgFps.toFixed(0)} FPS
                </span>
                <span className="diagnostics-latency">
                  · {result.frontend.longTasks.count} LT · {result.frontend.stateStore.notificationsPerSec.toFixed(1)}/s
                </span>
              </div>
            </div>

            {/* Metric 4: Hardware Acceleration */}
            <div className="diagnostics-metric-item">
              <span className="diagnostics-metric-label">{t('performance.diagnostics.hardwareAccel')}</span>
              <div className="diagnostics-metric-value-row">
                <span
                  className={`diagnostics-badge ${
                    result.frontend.hardwareAcceleration ? 'badge-green' : 'badge-blocked'
                  }`}
                >
                  {result.frontend.hardwareAcceleration
                    ? t('performance.diagnostics.hwActive')
                    : t('performance.diagnostics.hwSoftware')}
                </span>
              </div>
            </div>
          </div>

          {/* Advice Banner */}
          <div className={`diagnostics-advice-box advice-${result.analysis.severity}`}>
            <div className="diagnostics-advice-icon">
              {result.analysis.severity === 'optimal' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              ) : result.analysis.severity === 'blocked' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              )}
            </div>
            <p className="diagnostics-advice-text">{adviceMessage}</p>
          </div>

          {/* Expandable Technical Logs */}
          {result.logs.length > 0 && (
            <div className="diagnostics-logs-section">
              <div className="diagnostics-logs-toggle-row">
                <button
                  type="button"
                  className="btn btn-xs btn-outline"
                  onClick={() => setShowLogs(!showLogs)}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    style={{ transform: showLogs ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                  <span>{t('network.diagnostics.viewLogs')}</span>
                </button>
                {showLogs && (
                  <button
                    type="button"
                    className="btn btn-xs btn-outline"
                    onClick={handleCopyReport}
                  >
                    {t('performance.diagnostics.copyReport')}
                  </button>
                )}
              </div>
              {showLogs && (
                <div className="diagnostics-logs-scroll">
                  {result.logs.map((log, idx) => (
                    <div key={idx} className="p2p-test-log-line">
                      {log || '\u00A0'}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
