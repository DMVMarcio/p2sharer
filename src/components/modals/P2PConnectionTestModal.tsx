import React, { useState, useEffect, useRef, useId } from 'react';
import { useModalDialogBehavior } from '../common/useModalDialogBehavior.ts';
import { useModal } from '../../hooks/useModal.ts';
import { useLocale } from '../../hooks/useLocale.ts';
import { t } from '../../i18n/index.ts';
import { showToast } from '../../hooks/useToast.ts';
import {
  P2PConnectionTester,
  generateTestCode,
  type P2PTestState,
  type StepStatus,
} from '../../services/p2p_connection_test.ts';

export const P2PConnectionTestModal: React.FC = () => {
  useLocale();
  const id = useId();
  const { closeModal, isClosing } = useModal();
  const dialogRef = useModalDialogBehavior(closeModal, isClosing, false);

  const [mode, setMode] = useState<'host' | 'join'>('host');
  const [hostCode, setHostCode] = useState(() => generateTestCode());
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [copied, setCopied] = useState(false);

  const testerRef = useRef<P2PConnectionTester | null>(null);
  const [testState, setTestState] = useState<P2PTestState | null>(null);
  const logsBottomRef = useRef<HTMLDivElement | null>(null);

  // Initialize tester instance
  useEffect(() => {
    const tester = new P2PConnectionTester();
    testerRef.current = tester;
    const unsub = tester.subscribe((s) => {
      setTestState(s);
    });

    return () => {
      unsub();
      tester.cleanup();
      testerRef.current = null;
    };
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    if (logsBottomRef.current) {
      logsBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [testState?.logs.length]);

  const handleStartHost = () => {
    if (!testerRef.current) return;
    testerRef.current.start(hostCode, true);
  };

  const handleStartJoin = () => {
    if (!testerRef.current) return;
    const clean = joinCodeInput.trim().toUpperCase();
    if (!clean) {
      showToast(t('p2pTest.joinHint'), 3000, 'warning');
      return;
    }
    testerRef.current.start(clean, false);
  };

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(hostCode);
      setCopied(true);
      showToast(t('p2pTest.reportCopied'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast(hostCode);
    }
  };

  const handleCopyReport = async () => {
    if (!testerRef.current) return;
    const report = testerRef.current.generateReport();
    try {
      await navigator.clipboard.writeText(report);
      showToast(t('p2pTest.reportCopied'));
    } catch {
      showToast('Relatório gerado!');
    }
  };

  const handleReset = () => {
    if (testerRef.current) {
      testerRef.current.cleanup();
      testerRef.current = new P2PConnectionTester();
      testerRef.current.subscribe(setTestState);
    }
    setHostCode(generateTestCode());
    setJoinCodeInput('');
  };

  const renderStepIcon = (status: StepStatus) => {
    switch (status) {
      case 'success':
        return (
          <span className="step-status-icon step-success">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </span>
        );
      case 'running':
        return (
          <span className="step-status-icon step-running">
            <svg className="spinner-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="12" />
            </svg>
          </span>
        );
      case 'failed':
        return (
          <span className="step-status-icon step-failed">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </span>
        );
      default:
        return (
          <span className="step-status-icon step-pending">
            <circle cx="7" cy="7" r="3" fill="currentColor" opacity="0.3" />
          </span>
        );
    }
  };

  const isIdle = !testState || testState.phase === 'idle';

  return (
    <div className={`modal-overlay ${isClosing ? 'closing' : ''}`} id="modal-p2p-test">
      <div
        className="modal-card modal-p2p-test-card"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        inert={isClosing || undefined}
      >
        {/* Modal Header */}
        <div className="modal-header">
          <div className="modal-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <line x1="19" y1="8" x2="19" y2="14" />
              <line x1="22" y1="11" x2="16" y2="11" />
            </svg>
          </div>
          <h2 className="modal-title" id={`${id}-title`}>
            {t('p2pTest.modalTitle')}
          </h2>
          <button
            type="button"
            className="btn-close"
            onClick={closeModal}
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Modal Body */}
        <div className="modal-body p2p-test-modal-body">
          {isIdle ? (
            /* Setup Phase: Host or Join */
            <div className="p2p-test-setup">
              <div className="sidebar-tabs settings-subtabs p2p-test-subtabs" role="tablist">
                <button
                  type="button"
                  className={`tab-btn ${mode === 'host' ? 'active' : ''}`}
                  onClick={() => setMode('host')}
                  role="tab"
                  aria-selected={mode === 'host'}
                >
                  {t('p2pTest.tabHost')}
                </button>
                <button
                  type="button"
                  className={`tab-btn ${mode === 'join' ? 'active' : ''}`}
                  onClick={() => setMode('join')}
                  role="tab"
                  aria-selected={mode === 'join'}
                >
                  {t('p2pTest.tabJoin')}
                </button>
              </div>

              {mode === 'host' ? (
                <div className="p2p-test-panel">
                  <p className="p2p-test-hint">{t('p2pTest.hostHint')}</p>
                  <div className="p2p-test-code-box">
                    <span className="p2p-test-code-value">{hostCode}</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline"
                      onClick={handleCopyCode}
                    >
                      {copied ? '✓ Copiado' : 'Copiar'}
                    </button>
                  </div>
                  <div className="p2p-test-action-row">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleStartHost}
                    >
                      {t('p2pTest.startTest')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p2p-test-panel">
                  <p className="p2p-test-hint">{t('p2pTest.joinHint')}</p>
                  <div className="p2p-test-input-wrapper">
                    <input
                      type="text"
                      autoComplete="off"
                      className="text-input p2p-test-input"
                      placeholder="Ex: 8XF2A9"
                      maxLength={8}
                      value={joinCodeInput}
                      onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleStartJoin();
                      }}
                    />
                  </div>
                  <div className="p2p-test-action-row">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleStartJoin}
                      disabled={!joinCodeInput.trim()}
                    >
                      {t('p2pTest.startTest')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Live Diagnostics & Logs Phase */
            <div className="p2p-test-live">
              {/* Top Status Strip */}
              <div className="p2p-test-session-strip">
                <div className="p2p-test-session-badge">
                  <span>Código: </span>
                  <strong>{testState.code}</strong>
                </div>
                <div className="p2p-test-peer-badge">
                  {testState.remotePeerId ? (
                    <span className="peer-connected">Peer conectado ({testState.remotePeerId.slice(0, 6)}...)</span>
                  ) : (
                    <span className="peer-waiting">Aguardando entrada do amigo...</span>
                  )}
                </div>
              </div>

              {/* Step Checklist */}
              <div className="p2p-test-steps-list">
                <div className={`p2p-test-step-row status-${testState.stepSignaling}`}>
                  {renderStepIcon(testState.stepSignaling)}
                  <div className="p2p-test-step-content">
                    <span className="step-title">{t('p2pTest.stepSignaling')}</span>
                  </div>
                </div>

                <div className={`p2p-test-step-row status-${testState.stepOfferAnswer}`}>
                  {renderStepIcon(testState.stepOfferAnswer)}
                  <div className="p2p-test-step-content">
                    <span className="step-title">{t('p2pTest.stepOfferAnswer')}</span>
                  </div>
                </div>

                <div className={`p2p-test-step-row status-${testState.stepIceGathering}`}>
                  {renderStepIcon(testState.stepIceGathering)}
                  <div className="p2p-test-step-content">
                    <span className="step-title">{t('p2pTest.stepIceGathering')}</span>
                    <span className="step-detail">
                      Local: {testState.metrics.localCandidates.host} host, {testState.metrics.localCandidates.srflx} srflx
                      {testState.metrics.remoteCandidates.host > 0 &&
                        ` · Remoto: ${testState.metrics.remoteCandidates.host} host, ${testState.metrics.remoteCandidates.srflx} srflx`}
                    </span>
                  </div>
                </div>

                <div className={`p2p-test-step-row status-${testState.stepIceHandshake}`}>
                  {renderStepIcon(testState.stepIceHandshake)}
                  <div className="p2p-test-step-content">
                    <span className="step-title">{t('p2pTest.stepIceHandshake')}</span>
                    {testState.metrics.connectionType && (
                      <span className="step-detail">
                        Rota: {testState.metrics.connectionType === 'virtual_vpn' ? 'VPN (Radmin/Hamachi)' : testState.metrics.connectionType === 'direct_stun' ? 'P2P Direto (STUN)' : testState.metrics.connectionType}
                      </span>
                    )}
                  </div>
                </div>

                <div className={`p2p-test-step-row status-${testState.stepDataChannel}`}>
                  {renderStepIcon(testState.stepDataChannel)}
                  <div className="p2p-test-step-content">
                    <span className="step-title">{t('p2pTest.stepDataChannel')}</span>
                    {testState.metrics.avgRttMs != null && (
                      <span className="step-detail">
                        Ping médio: {testState.metrics.avgRttMs} ms ({testState.metrics.rttSamples.length}/5 amostras)
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Verdict Banner (when completed or failed) */}
              {testState.verdict && (
                <div className={`p2p-test-verdict-box verdict-${testState.verdict}`}>
                  <div className="p2p-test-verdict-icon">
                    {testState.verdict === 'optimal' || testState.verdict === 'vpn' ? (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                        <polyline points="22 4 12 14.01 9 11.01" />
                      </svg>
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                    )}
                  </div>
                  <div className="p2p-test-verdict-text">
                    <strong>
                      {testState.verdict === 'optimal'
                        ? 'Conexão P2P Direta Estabelecida!'
                        : testState.verdict === 'vpn'
                        ? 'Conectado via Rede Virtual VPN (Radmin)!'
                        : 'Falha na Conexão P2P'}
                    </strong>
                    <p>{testState.verdictMessage}</p>
                  </div>
                </div>
              )}

              {/* Live Technical Logs Console */}
              <div className="p2p-test-logs-wrapper">
                <div className="p2p-test-logs-header">
                  <span className="logs-header-title">Logs de Diagnóstico em Tempo Real</span>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline"
                    onClick={handleCopyReport}
                  >
                    {t('p2pTest.copyReport')}
                  </button>
                </div>
                <div className="p2p-test-logs-scroll">
                  {testState.logs.map((line, idx) => (
                    <div key={idx} className="p2p-test-log-line">
                      {line}
                    </div>
                  ))}
                  <div ref={logsBottomRef} />
                </div>
              </div>

              {/* Actions Footer */}
              <div className="p2p-test-footer">
                {(testState.phase === 'done' || testState.phase === 'failed') && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleReset}
                  >
                    Novo Teste
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={closeModal}
                >
                  Fechar
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
