import React, { useEffect, useState, useCallback } from 'react';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { showToast } from '../../hooks/useToast';
import { telemetryService } from '../../services/telemetry_service';
import type { SystemTelemetryReport, TelemetryEvent } from '../../core/types';

export const DiagnosticsModal: React.FC = () => {
  const { closeModal, isClosing } = useModal();
  const { currentRoomCode, username, isSharingScreen } = useRoom();

  const [activeTab, setActiveTab] = useState<'hardware' | 'processes' | 'subsystems' | 'timeline'>('hardware');
  const [report, setReport] = useState<SystemTelemetryReport | null>(() => telemetryService.getLatestReport());
  const [events, setEvents] = useState<TelemetryEvent[]>(() => telemetryService.getEvents());
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);

  // Poll telemetry every second while modal is open
  useEffect(() => {
    if (autoRefresh) {
      telemetryService.startPolling(1000);
    } else {
      telemetryService.stopPolling();
    }

    const unsubReport = telemetryService.subscribeReport((newReport) => {
      setReport(newReport);
    });

    const unsubEvents = telemetryService.subscribeEvents(() => {
      setEvents(telemetryService.getEvents());
    });

    return () => {
      telemetryService.stopPolling();
      unsubReport();
      unsubEvents();
    };
  }, [autoRefresh]);

  const handleCopyReport = useCallback(() => {
    const md = telemetryService.exportMarkdownReport({
      username: username || 'Usuário',
      roomCode: currentRoomCode || 'Sem sala',
      isSharing: isSharingScreen,
    });

    navigator.clipboard
      .writeText(md)
      .then(() => {
        setIsCopied(true);
        showToast('Relatório completo copiado para a área de transferência!');
        setTimeout(() => setIsCopied(false), 2500);
      })
      .catch((err) => {
        showToast(`Erro ao copiar relatório: ${err}`);
      });
  }, [username, currentRoomCode, isSharingScreen]);

  const handleManualRefresh = async () => {
    const res = await telemetryService.fetchReport();
    if (res) {
      setReport(res);
      setEvents(telemetryService.getEvents());
      showToast('Dados de telemetria atualizados!');
    }
  };

  const gpu = report?.gpu;

  return (
    <div
      className={`modal-backdrop ${isClosing ? 'closing' : ''}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div
        className={`modal-card modal-lg ${isClosing ? 'closing' : ''}`}
        style={{ maxWidth: '880px', width: '94%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="diagnostics-title"
      >
        {/* Header */}
        <div className="modal-header" style={{ paddingBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#60a5fa',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </div>
            <div>
              <h2 id="diagnostics-title" className="modal-title" style={{ fontSize: '1.15rem', margin: 0 }}>
                Painel de Telemetria & Diagnóstico
              </h2>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Monitoramento ao vivo de CPU, GPU, ventoinhas, threads e subsistemas
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn-icon-close"
            onClick={closeModal}
            aria-label="Fechar diagnóstico"
          >
            ✕
          </button>
        </div>

        {/* Quick KPI Bar & Actions */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '8px',
            padding: '10px 16px',
            backgroundColor: 'var(--bg-surface)',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span
              style={{
                padding: '4px 8px',
                borderRadius: '6px',
                backgroundColor: 'rgba(255, 255, 255, 0.06)',
                fontSize: '0.78rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              CPU: <strong>{report?.cpu_global_pct.toFixed(0)}%</strong>
              {report?.cpu_temperature_c && ` (${report.cpu_temperature_c.toFixed(0)}°C)`}
            </span>

            {gpu && (
              <span
                style={{
                  padding: '4px 8px',
                  borderRadius: '6px',
                  backgroundColor: 'rgba(16, 185, 129, 0.1)',
                  color: '#34d399',
                  fontSize: '0.78rem',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                GPU: <strong>{gpu.temperature_c ?? 'N/D'}°C</strong>
                {gpu.fan_speed_pct !== undefined && ` | Ventoinha: ${gpu.fan_speed_pct}%`}
                {gpu.utilization_encoder_pct !== undefined && ` | NVENC: ${gpu.utilization_encoder_pct}%`}
              </span>
            )}

            <span
              style={{
                padding: '4px 8px',
                borderRadius: '6px',
                backgroundColor: 'rgba(255, 255, 255, 0.06)',
                fontSize: '0.78rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              P2Sharer: <strong>{report?.p2sharer_processes.length || 0} procs</strong> ({report?.total_p2sharer_threads || 0} threads)
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={handleManualRefresh}
              style={{ fontSize: '0.78rem', padding: '4px 10px' }}
            >
              Atualizar
            </button>

            <button
              type="button"
              className={`btn btn-sm ${isCopied ? 'btn-success' : 'btn-primary'}`}
              onClick={handleCopyReport}
              style={{
                fontSize: '0.78rem',
                padding: '4px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
              </svg>
              <span>{isCopied ? 'Copiado!' : 'Copiar Relatório'}</span>
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="settings-tabs-nav" style={{ padding: '0 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'hardware' ? 'active' : ''}`}
            onClick={() => setActiveTab('hardware')}
          >
            Hardware & Térmica
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'processes' ? 'active' : ''}`}
            onClick={() => setActiveTab('processes')}
          >
            Processos do P2Sharer ({report?.p2sharer_processes.length || 0})
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'subsystems' ? 'active' : ''}`}
            onClick={() => setActiveTab('subsystems')}
          >
            Subsistemas P2P & Captura
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'timeline' ? 'active' : ''}`}
            onClick={() => setActiveTab('timeline')}
          >
            Linha do Tempo ({events.length})
          </button>
        </div>

        {/* Body content */}
        <div
          className="modal-body"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
        >
          {/* TAB 1: HARDWARE & THERMAL */}
          {activeTab === 'hardware' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* GPU Section */}
              <div
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-default)',
                  borderRadius: '10px',
                  padding: '14px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>Placa de Vídeo (GPU)</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {gpu?.name || 'Nenhuma GPU dedicada detectada via nvidia-smi'}
                    </span>
                  </div>
                  {gpu && (
                    <span
                      style={{
                        fontSize: '0.75rem',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        backgroundColor: 'rgba(255, 255, 255, 0.08)',
                      }}
                    >
                      Fonte: {gpu.query_source}
                    </span>
                  )}
                </div>

                {gpu ? (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                      gap: '12px',
                    }}
                  >
                    <div style={{ padding: '10px', backgroundColor: 'var(--bg-card)', borderRadius: '8px' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Temperatura</span>
                      <div style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: '4px', color: (gpu.temperature_c || 0) > 75 ? '#f87171' : 'var(--text-primary)' }}>
                        {gpu.temperature_c !== undefined ? `${gpu.temperature_c}°C` : 'N/D'}
                      </div>
                    </div>

                    <div style={{ padding: '10px', backgroundColor: 'var(--bg-card)', borderRadius: '8px' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Ventoinha (Fan Speed)</span>
                      <div style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: '4px', color: (gpu.fan_speed_pct || 0) > 80 ? '#f87171' : 'var(--text-primary)' }}>
                        {gpu.fan_speed_pct !== undefined ? `${gpu.fan_speed_pct}%` : 'N/D'}
                      </div>
                    </div>

                    <div style={{ padding: '10px', backgroundColor: 'var(--bg-card)', borderRadius: '8px' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Codificador (NVENC)</span>
                      <div style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: '4px', color: (gpu.utilization_encoder_pct || 0) > 0 ? '#34d399' : 'var(--text-muted)' }}>
                        {gpu.utilization_encoder_pct !== undefined ? `${gpu.utilization_encoder_pct}%` : 'N/D'}
                      </div>
                    </div>

                    <div style={{ padding: '10px', backgroundColor: 'var(--bg-card)', borderRadius: '8px' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Uso 3D da GPU</span>
                      <div style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: '4px' }}>
                        {gpu.utilization_gpu_pct !== undefined ? `${gpu.utilization_gpu_pct}%` : 'N/D'}
                      </div>
                    </div>

                    <div style={{ padding: '10px', backgroundColor: 'var(--bg-card)', borderRadius: '8px' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Consumo Elétrico</span>
                      <div style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: '4px' }}>
                        {gpu.power_watts !== undefined ? `${gpu.power_watts.toFixed(0)} W` : 'N/D'}
                      </div>
                    </div>

                    <div style={{ padding: '10px', backgroundColor: 'var(--bg-card)', borderRadius: '8px' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>VRAM Alocada</span>
                      <div style={{ fontSize: '1.1rem', fontWeight: 700, marginTop: '4px' }}>
                        {gpu.memory_used_mb !== undefined ? `${gpu.memory_used_mb} MB` : 'N/D'}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: '12px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    Telemetria detalhada de GPU requer placa de vídeo NVIDIA com drivers instalados.
                  </div>
                )}
              </div>

              {/* CPU & Memory Section */}
              <div
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-default)',
                  borderRadius: '10px',
                  padding: '14px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>Processador (CPU) & Memória</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    RAM: {(report?.memory_used_mb || 0) / 1024 > 0 ? `${((report?.memory_used_mb || 0) / 1024).toFixed(1)} GB` : '0 GB'} / {((report?.memory_total_mb || 0) / 1024).toFixed(1)} GB
                  </span>
                </div>

                {/* Per-Core Meter Grid */}
                <div style={{ marginBottom: '8px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  Uso por Núcleo / Thread ({report?.cpu_cores.length || 0} núcleos lógicos):
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
                    gap: '8px',
                    maxHeight: '220px',
                    overflowY: 'auto',
                    paddingRight: '4px',
                  }}
                >
                  {report?.cpu_cores.map((c) => {
                    const isHigh = c.usage_pct > 80;
                    return (
                      <div
                        key={c.id}
                        style={{
                          padding: '6px 8px',
                          backgroundColor: isHigh ? 'rgba(239, 68, 68, 0.12)' : 'var(--bg-card)',
                          border: `1px solid ${isHigh ? 'rgba(239, 68, 68, 0.3)' : 'var(--border-subtle)'}`,
                          borderRadius: '6px',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', marginBottom: '4px' }}>
                          <span style={{ fontWeight: 600 }}>Core {c.id}</span>
                          <span style={{ color: isHigh ? '#f87171' : 'var(--text-primary)', fontWeight: 700 }}>
                            {c.usage_pct.toFixed(0)}%
                          </span>
                        </div>
                        <div style={{ height: '4px', backgroundColor: 'rgba(255, 255, 255, 0.08)', borderRadius: '2px', overflow: 'hidden' }}>
                          <div
                            style={{
                              height: '100%',
                              width: `${Math.min(100, Math.max(0, c.usage_pct))}%`,
                              backgroundColor: isHigh ? '#ef4444' : 'var(--accent-color, #3b82f6)',
                              transition: 'width 0.2s ease',
                            }}
                          />
                        </div>
                        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '3px' }}>
                          {c.frequency_mhz} MHz
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: PROCESSES */}
          {activeTab === 'processes' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Processos do aplicativo (Host Rust + WebView2 Edge Runtime):
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-default)', color: 'var(--text-muted)' }}>
                      <th style={{ padding: '8px' }}>PID</th>
                      <th style={{ padding: '8px' }}>Função / Papel</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>CPU %</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>RAM (MB)</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Threads</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Tempo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report?.p2sharer_processes.map((p) => {
                      const mins = Math.floor(p.run_time_secs / 60);
                      const secs = p.run_time_secs % 60;
                      return (
                        <tr
                          key={p.pid}
                          style={{
                            borderBottom: '1px solid var(--border-subtle)',
                            backgroundColor: p.role.includes('Host') ? 'rgba(59, 130, 246, 0.05)' : 'transparent',
                          }}
                        >
                          <td style={{ padding: '8px', fontFamily: 'var(--font-mono)' }}>{p.pid}</td>
                          <td style={{ padding: '8px', fontWeight: p.role.includes('Host') ? 600 : 400 }}>
                            {p.role}
                          </td>
                          <td
                            style={{
                              padding: '8px',
                              textAlign: 'right',
                              fontFamily: 'var(--font-mono)',
                              fontWeight: p.cpu_pct > 5 ? 700 : 400,
                              color: p.cpu_pct > 10 ? '#f87171' : 'var(--text-primary)',
                            }}
                          >
                            {p.cpu_pct.toFixed(1)}%
                          </td>
                          <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                            {p.memory_mb.toFixed(1)}
                          </td>
                          <td
                            style={{
                              padding: '8px',
                              textAlign: 'right',
                              fontFamily: 'var(--font-mono)',
                              fontWeight: p.threads > 50 ? 700 : 400,
                              color: p.threads > 100 ? '#f87171' : 'var(--text-primary)',
                            }}
                          >
                            {p.threads}
                          </td>
                          <td style={{ padding: '8px', textAlign: 'right', color: 'var(--text-muted)' }}>
                            {mins}m {secs}s
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 3: SUBSYSTEMS */}
          {activeTab === 'subsystems' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px' }}>
              <div style={{ padding: '14px', backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: '10px' }}>
                <h4 style={{ margin: '0 0 10px 0', fontSize: '0.9rem' }}>Captura de Vídeo (Tela)</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.82rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Estado:</span>
                    <strong>{report?.subsystems.is_screen_capturing ? 'ATIVO' : 'INATIVO'}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Motor WGC (Windows Graphics):</span>
                    <span>{report?.subsystems.active_wgc ? 'Ativo' : 'Parado'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Porta WebSocket Local:</span>
                    <span>{report?.subsystems.ws_port || 49153}</span>
                  </div>
                </div>
              </div>

              <div style={{ padding: '14px', backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: '10px' }}>
                <h4 style={{ margin: '0 0 10px 0', fontSize: '0.9rem' }}>Captura de Áudio (WASAPI)</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.82rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Loopback WASAPI:</span>
                    <strong>{report?.subsystems.is_audio_capturing ? 'ATIVO' : 'INATIVO'}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Taxa de Amostragem:</span>
                    <span>48.000 Hz (Estéreo)</span>
                  </div>
                </div>
              </div>

              <div style={{ padding: '14px', backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: '10px' }}>
                <h4 style={{ margin: '0 0 10px 0', fontSize: '0.9rem' }}>Sessão P2P WebRTC</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.82rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Sala Conectada:</span>
                    <span>{currentRoomCode || 'Nenhuma'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Transmissão Local:</span>
                    <span>{isSharingScreen ? 'Ao Vivo' : 'Inativo'}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: TIMELINE / EVENT LOG */}
          {activeTab === 'timeline' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  Ações e transições de estado registradas nesta sessão:
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  onClick={() => {
                    telemetryService.clearEvents();
                    setEvents(telemetryService.getEvents());
                  }}
                  style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                >
                  Limpar
                </button>
              </div>

              <div
                style={{
                  maxHeight: '340px',
                  overflowY: 'auto',
                  border: '1px solid var(--border-default)',
                  borderRadius: '8px',
                  backgroundColor: 'var(--bg-surface)',
                  padding: '8px',
                }}
              >
                {events.length === 0 ? (
                  <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    Nenhum evento registrado.
                  </div>
                ) : (
                  events.map((e, idx) => {
                    const timeStr = new Date(e.timestamp).toLocaleTimeString();
                    const categoryColors: Record<string, string> = {
                      CAPTURE: '#60a5fa',
                      WEBRTC: '#34d399',
                      AUDIO: '#f59e0b',
                      ROOM: '#a78bfa',
                      SYSTEM: '#9ca3af',
                    };
                    const color = categoryColors[e.category] || '#9ca3af';

                    return (
                      <div
                        key={idx}
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          gap: '10px',
                          padding: '6px 8px',
                          borderBottom: '1px solid var(--border-subtle)',
                          fontSize: '0.78rem',
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{timeStr}</span>
                        <span
                          style={{
                            padding: '1px 5px',
                            borderRadius: '4px',
                            fontSize: '0.68rem',
                            fontWeight: 700,
                            backgroundColor: `${color}20`,
                            color: color,
                          }}
                        >
                          {e.category}
                        </span>
                        <span style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                          {e.message}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="modal-footer"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 16px',
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <span>Atualizar telemetria automaticamente a cada 1.0s</span>
          </label>

          <button type="button" className="btn btn-secondary" onClick={closeModal}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};
