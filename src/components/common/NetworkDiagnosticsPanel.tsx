import React, { useState, useCallback } from 'react';
import { t } from '../../i18n/index.ts';
import { useLocale } from '../../hooks/useLocale.ts';
import { runNetworkDiagnostics, type NetworkDiagnosticResult } from '../../services/network_diagnostics.ts';

export const NetworkDiagnosticsPanel: React.FC = () => {
  useLocale();
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<NetworkDiagnosticResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRun = useCallback(async () => {
    setIsRunning(true);
    setError(null);
    try {
      const diag = await runNetworkDiagnostics();
      setResult(diag);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  }, []);

  return (
    <div className="network-diagnostics-container">
      <div className="settings-pane-header rendezvous-header">
        <h3 className="settings-pane-title">{t('network.diagnostics.title')}</h3>
        <p className="settings-pane-desc">{t('network.diagnostics.desc')}</p>
      </div>

      <div className="network-diagnostics-actions">
        <button
          type="button"
          className="btn btn-sm btn-outline network-diagnostics-btn"
          onClick={handleRun}
          disabled={isRunning}
        >
          {isRunning ? (
            <>
              <svg className="spinner-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="12" />
              </svg>
              <span>{t('network.diagnostics.testing')}</span>
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <span>{t('network.diagnostics.run')}</span>
            </>
          )}
        </button>
      </div>

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
        <div className={`network-diagnostics-card result-${result.recommendation}`}>
          <div className="diagnostics-metric-grid">
            {/* Metric 1: NAT Type */}
            <div className="diagnostics-metric-item">
              <span className="diagnostics-metric-label">{t('network.diagnostics.natType')}</span>
              <div className="diagnostics-metric-value-row">
                <span className={`diagnostics-badge badge-${result.nat_type}`}>
                  {result.nat_type === 'cone'
                    ? t('network.diagnostics.natCone')
                    : result.nat_type === 'symmetric'
                    ? t('network.diagnostics.natSymmetric')
                    : result.nat_type === 'blocked'
                    ? t('network.diagnostics.natBlocked')
                    : result.nat_description}
                </span>
              </div>
            </div>

            {/* Metric 2: CGNAT Status */}
            <div className="diagnostics-metric-item">
              <span className="diagnostics-metric-label">{t('network.diagnostics.cgnat')}</span>
              <div className="diagnostics-metric-value-row">
                <span className={`diagnostics-badge ${result.cgnat_detected ? 'badge-amber' : result.double_nat_detected ? 'badge-amber' : 'badge-green'}`}>
                  {result.cgnat_detected
                    ? t('network.diagnostics.cgnatYes')
                    : result.double_nat_detected
                    ? t('network.diagnostics.doubleNat')
                    : t('network.diagnostics.cgnatNo')}
                </span>
              </div>
            </div>

            {/* Metric 3: Router UPnP */}
            <div className="diagnostics-metric-item">
              <span className="diagnostics-metric-label">{t('network.diagnostics.upnp')}</span>
              <div className="diagnostics-metric-value-row">
                <span className={`diagnostics-badge ${result.upnp_available ? 'badge-green' : 'badge-muted'}`}>
                  {result.upnp_available
                    ? t('network.diagnostics.upnpActive')
                    : t('network.diagnostics.upnpInactive')}
                </span>
              </div>
            </div>

            {/* Metric 4: Public Endpoint & Latency */}
            <div className="diagnostics-metric-item">
              <span className="diagnostics-metric-label">{t('network.diagnostics.publicEndpoint')}</span>
              <div className="diagnostics-metric-value-row">
                <span className="diagnostics-endpoint-text">
                  {result.public_ip ?? '—'}
                  {result.stun_latency_ms != null && (
                    <span className="diagnostics-latency"> · {result.stun_latency_ms} ms</span>
                  )}
                </span>
              </div>
            </div>
          </div>

          {/* Advice / Recommendation Banner */}
          <div className={`diagnostics-advice-box advice-${result.recommendation}`}>
            <div className="diagnostics-advice-icon">
              {result.recommendation === 'optimal' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              ) : result.recommendation === 'blocked' ? (
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
            <p className="diagnostics-advice-text">
              {result.recommendation === 'optimal'
                ? t('network.diagnostics.recOptimal')
                : result.recommendation === 'blocked'
                ? t('network.diagnostics.recBlocked')
                : result.recommendation === 'restricted'
                ? t('network.diagnostics.recRestricted')
                : t('network.diagnostics.recModerate')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
