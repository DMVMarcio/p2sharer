import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useModal } from '../../hooks/useModal';
import { useAppTheme, ACCENT_COLORS } from '../../hooks/useAppTheme';
import { stateStore } from '../../core/state_store';
import { soundEffects } from '../../ui/sound_effects';
import { showToast } from '../../hooks/useToast';
import { ThemeMode } from '../../core/types';

export const SettingsModal: React.FC = () => {
  const { closeModal } = useModal();
  const { themeMode, accentColor, setThemeMode, setAccentColor } = useAppTheme();

  const [activeTab, setActiveTab] = useState<
    'profile' | 'appearance' | 'audio' | 'stream' | 'network' | 'diagnostics'
  >('profile');

  // Form states initialized once upon mounting
  const [nick, setNick] = useState(() => stateStore.username);
  const [sfxEnabled, setSfxEnabled] = useState(() => soundEffects.getEnabled());
  const [sfxVolume, setSfxVolume] = useState(() => Math.round(soundEffects.getVolume() * 100));

  const [defaultRes, setDefaultRes] = useState(
    () => localStorage.getItem('p2sharer_default_res') || '1080p'
  );
  const [defaultFps, setDefaultFps] = useState(
    () => localStorage.getItem('p2sharer_default_fps') || '60'
  );
  const [defaultBitrate, setDefaultBitrate] = useState(
    () => localStorage.getItem('p2sharer_default_bitrate') || '15000'
  );
  const [defaultCursor, setDefaultCursor] = useState(
    () => localStorage.getItem('p2sharer_default_cursor') !== 'false'
  );

  const [turnEnabled, setTurnEnabled] = useState(
    () => localStorage.getItem('p2sharer_turn_enabled') === 'true'
  );
  const [turnUrl, setTurnUrl] = useState(() => localStorage.getItem('p2sharer_turn_url') || '');
  const [turnUser, setTurnUser] = useState(() => localStorage.getItem('p2sharer_turn_user') || '');
  const [turnCred, setTurnCred] = useState(() => localStorage.getItem('p2sharer_turn_cred') || '');
  const [turnForceRelay, setTurnForceRelay] = useState(
    () => localStorage.getItem('p2sharer_turn_force_relay') === 'true'
  );

  const [logPath, setLogPath] = useState('Carregando caminho do log...');

  useEffect(() => {
    invoke<string>('get_log_file_path')
      .then((path) => setLogPath(path))
      .catch(() => setLogPath('Não foi possível obter o caminho do log.'));
  }, []);

  const handleSave = () => {
    // Save username
    if (nick.trim()) {
      stateStore.set((s) => {
        s.username = nick.trim();
      });
      localStorage.setItem('p2sharer_username', nick.trim());
    }

    // Save SFX
    soundEffects.setEnabled(sfxEnabled);
    soundEffects.setVolume(sfxVolume / 100);

    // Save Stream defaults
    localStorage.setItem('p2sharer_default_res', defaultRes);
    localStorage.setItem('p2sharer_default_fps', defaultFps);
    localStorage.setItem('p2sharer_default_bitrate', defaultBitrate);
    localStorage.setItem('p2sharer_default_cursor', defaultCursor.toString());

    stateStore.set((s) => {
      s.currentResolution = s.parseResolution(defaultRes);
      s.currentFps = parseInt(defaultFps, 10);
      s.currentBitrate = parseInt(defaultBitrate, 10);
    });

    // Save TURN
    localStorage.setItem('p2sharer_turn_enabled', turnEnabled ? 'true' : 'false');
    let sanitizedTurn = turnUrl.trim();
    if (
      sanitizedTurn &&
      !sanitizedTurn.startsWith('turn:') &&
      !sanitizedTurn.startsWith('turns:') &&
      !sanitizedTurn.startsWith('stun:')
    ) {
      sanitizedTurn = `turn:${sanitizedTurn}`;
    }
    localStorage.setItem('p2sharer_turn_url', sanitizedTurn);
    localStorage.setItem('p2sharer_turn_user', turnUser.trim());
    localStorage.setItem('p2sharer_turn_cred', turnCred.trim());
    localStorage.setItem('p2sharer_turn_force_relay', turnForceRelay ? 'true' : 'false');

    closeModal();
    showToast('Configurações salvas com sucesso!');
  };

  const handleOpenLatestLog = async () => {
    try {
      await invoke('open_latest_log');
    } catch (err) {
      showToast(`Erro: ${err}`);
    }
  };

  const handleOpenLogFolder = async () => {
    try {
      await invoke('open_log_folder');
    } catch (err) {
      showToast(`Erro: ${err}`);
    }
  };

  const handleClearLog = async () => {
    try {
      await invoke('clear_log_file');
      showToast('Log limpo com sucesso!');
    } catch (err) {
      showToast(`Erro: ${err}`);
    }
  };

  return (
    <div className="modal-overlay" id="modal-settings">
      <div className="modal-card modal-settings">
        <div className="modal-header">
          <div className="modal-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </div>
          <div>
            <h2>Configurações</h2>
            <p className="modal-subtitle">Personalize a aparência, áudio, transmissão e rede.</p>
          </div>
          <button className="btn-close" id="btn-close-settings" onClick={closeModal}>
            &times;
          </button>
        </div>

        <div className="modal-body-settings-layout">
          {/* Left Vertical Sidebar Tabs */}
          <nav className="settings-nav-sidebar">
            <button
              type="button"
              className={`settings-nav-item ${activeTab === 'profile' ? 'active' : ''}`}
              onClick={() => setActiveTab('profile')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
              <span>Perfil</span>
            </button>

            <button
              type="button"
              className={`settings-nav-item ${activeTab === 'appearance' ? 'active' : ''}`}
              onClick={() => setActiveTab('appearance')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="4"/>
                <path d="M12 2v2"/>
                <path d="M12 20v2"/>
                <path d="m4.93 4.93 1.41 1.41"/>
                <path d="m17.66 17.66 1.41 1.41"/>
                <path d="M2 12h2"/>
                <path d="M20 12h2"/>
                <path d="m6.34 17.66-1.41 1.41"/>
                <path d="m19.07 4.93-1.41 1.41"/>
              </svg>
              <span>Aparência</span>
            </button>

            <button
              type="button"
              className={`settings-nav-item ${activeTab === 'audio' ? 'active' : ''}`}
              onClick={() => setActiveTab('audio')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
              </svg>
              <span>Efeitos Sonoros</span>
            </button>

            <button
              type="button"
              className={`settings-nav-item ${activeTab === 'stream' ? 'active' : ''}`}
              onClick={() => setActiveTab('stream')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect width="20" height="14" x="2" y="3" rx="2"/>
                <line x1="8" x2="16" y1="21" y2="21"/>
                <line x1="12" x2="12" y1="17" y2="21"/>
              </svg>
              <span>Transmissão</span>
            </button>

            <button
              type="button"
              className={`settings-nav-item ${activeTab === 'network' ? 'active' : ''}`}
              onClick={() => setActiveTab('network')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="2" x2="22" y1="12" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
              <span>Rede & TURN</span>
            </button>

            <button
              type="button"
              className={`settings-nav-item ${activeTab === 'diagnostics' ? 'active' : ''}`}
              onClick={() => setActiveTab('diagnostics')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
              </svg>
              <span>Diagnóstico & Logs</span>
            </button>
          </nav>

          {/* Right Content Panes */}
          <div className="settings-tab-content-area">
            {/* TAB 1: PERFIL */}
            {activeTab === 'profile' && (
              <div className="settings-tab-pane active" id="settings-pane-profile">
                <div className="settings-pane-header">
                  <h3 className="settings-pane-title">Perfil do Participante</h3>
                  <p className="settings-pane-desc">Defina seu nome exibido na lista de participantes, cards e chat.</p>
                </div>

                <div className="settings-row">
                  <label className="settings-label" htmlFor="settings-input-username">
                    Apelido na Sala:
                  </label>
                  <input
                    type="text"
                    id="settings-input-username"
                    className="text-input"
                    placeholder="Ex: Marcos"
                    maxLength={25}
                    value={nick}
                    onChange={(e) => setNick(e.target.value)}
                  />
                  <p className="field-info-text" style={{ marginTop: '4px' }}>
                    Este nome será enviado aos outros participantes assim que você se conectar à sala.
                  </p>
                </div>
              </div>
            )}

            {/* TAB 2: APARÊNCIA */}
            {activeTab === 'appearance' && (
              <div className="settings-tab-pane active" id="settings-pane-appearance">
                <div className="settings-pane-header">
                  <h3 className="settings-pane-title">Aparência e Tema</h3>
                  <p className="settings-pane-desc">Personalize o tema visual e as cores da interface da aplicação.</p>
                </div>

                <div className="settings-row">
                  <label className="settings-label">Modo de Exibição:</label>
                  <div className="theme-mode-pills">
                    {(['dark', 'light', 'system'] as ThemeMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={`pill-btn ${themeMode === mode ? 'active' : ''}`}
                        onClick={() => setThemeMode(mode)}
                      >
                        {mode === 'dark' && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
                          </svg>
                        )}
                        {mode === 'light' && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="4"/>
                            <path d="M12 2v2"/>
                            <path d="M12 20v2"/>
                            <path d="m4.93 4.93 1.41 1.41"/>
                            <path d="m17.66 17.66 1.41 1.41"/>
                            <path d="M2 12h2"/>
                            <path d="M20 12h2"/>
                            <path d="m6.34 17.66-1.41 1.41"/>
                            <path d="m19.07 4.93-1.41 1.41"/>
                          </svg>
                        )}
                        {mode === 'system' && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect width="20" height="14" x="2" y="3" rx="2"/>
                            <line x1="8" x2="16" y1="21" y2="21"/>
                            <line x1="12" x2="12" y1="17" y2="21"/>
                          </svg>
                        )}
                        <span>{mode === 'dark' ? 'Escuro' : mode === 'light' ? 'Claro' : 'Sistema'}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-row" style={{ marginTop: '10px' }}>
                  <label className="settings-label">Cor de Destaque:</label>
                  <div className="accent-colors-palette" id="accent-colors-palette">
                    {ACCENT_COLORS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`accent-swatch ${accentColor === item.id ? 'active' : ''}`}
                        style={{ '--swatch-color': item.color } as React.CSSProperties}
                        title={item.label}
                        onClick={() => setAccentColor(item.id)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: ÁUDIO & EFEITOS SONOROS */}
            {activeTab === 'audio' && (
              <div className="settings-tab-pane active" id="settings-pane-audio">
                <div className="settings-pane-header">
                  <h3 className="settings-pane-title">Efeitos Sonoros & Notificações</h3>
                  <p className="settings-pane-desc">
                    Sons ao vivo para início/fim de transmissão, espectadores e entrada/saída de participantes.
                  </p>
                </div>

                <div className="settings-row">
                  <label className="settings-switch-row" htmlFor="settings-check-sfx-enabled">
                    <div className="settings-switch-label-group">
                      <span className="settings-switch-title">Efeitos Sonoros</span>
                      <span className="settings-switch-subtitle">
                        Ativar notificações sonoras para eventos da sala e transmissões
                      </span>
                    </div>
                    <div className="modern-switch">
                      <input
                        type="checkbox"
                        id="settings-check-sfx-enabled"
                        checked={sfxEnabled}
                        onChange={(e) => setSfxEnabled(e.target.checked)}
                      />
                      <span className="switch-slider"></span>
                    </div>
                  </label>
                </div>

                <div className="settings-row" id="settings-sfx-volume-row" style={{ marginTop: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                    <label className="settings-label" htmlFor="settings-slider-sfx-volume" style={{ marginBottom: 0 }}>
                      Volume dos Efeitos:
                    </label>
                    <span
                      id="settings-sfx-volume-label"
                      style={{
                        fontSize: '13px',
                        fontWeight: 700,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--accent-color)',
                      }}
                    >
                      {sfxVolume}%
                    </span>
                  </div>
                  <div className="settings-slider-container">
                    <input
                      type="range"
                      id="settings-slider-sfx-volume"
                      min="0"
                      max="100"
                      value={sfxVolume}
                      className="settings-slider-input"
                      onChange={(e) => setSfxVolume(parseInt(e.target.value, 10))}
                    />
                  </div>
                </div>

                <div className="settings-row" style={{ marginTop: '14px' }}>
                  <label className="settings-label">Testar e Pré-escutar Sons:</label>
                  <div className="sfx-test-buttons-grid">
                    <button
                      type="button"
                      className="btn btn-sm btn-outline"
                      onClick={() => soundEffects.playUserJoin()}
                      title="Testar som de entrada na sala"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
                        <polyline points="10 17 15 12 10 7"/>
                        <line x1="15" x2="3" y1="12" y2="12"/>
                      </svg>
                      <span>Entrada na Sala</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline"
                      onClick={() => soundEffects.playScreenShareStart()}
                      title="Testar som de início de transmissão"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                      </svg>
                      <span>Iniciar Transmissão</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline"
                      onClick={() => soundEffects.playWatchStreamStart()}
                      title="Testar som de espectador assistindo"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="3"/>
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"/>
                      </svg>
                      <span>Começar a Assistir</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline"
                      onClick={() => soundEffects.playWatchStreamStop()}
                      title="Testar som de parar de assistir"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                      <span>Parar de Assistir</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 4: TRANSMISSÃO */}
            {activeTab === 'stream' && (
              <div className="settings-tab-pane active" id="settings-pane-stream">
                <div className="settings-pane-header">
                  <h3 className="settings-pane-title">Padrões de Transmissão</h3>
                  <p className="settings-pane-desc">Valores padrão aplicados ao abrir o seletor de tela ou janela.</p>
                </div>

                <div className="settings-row-grid">
                  <div className="settings-col">
                    <label className="settings-label" htmlFor="settings-default-resolution">
                      Resolução Padrão:
                    </label>
                    <select
                      id="settings-default-resolution"
                      className="select-input-sm"
                      value={defaultRes}
                      onChange={(e) => {
                        const newRes = e.target.value;
                        setDefaultRes(newRes);
                        setDefaultBitrate(String(stateStore.getDefaultBitrateForResolution(newRes)));
                      }}
                    >
                      <option value="4k">4K (3840x2160)</option>
                      <option value="1440p">1440p 2K</option>
                      <option value="1080p">1080p Full HD</option>
                      <option value="720p">720p HD</option>
                      <option value="480p">480p SD</option>
                      <option value="360p">360p Baixa</option>
                    </select>
                  </div>

                  <div className="settings-col">
                    <label className="settings-label" htmlFor="settings-default-fps">
                      Taxa de FPS:
                    </label>
                    <select
                      id="settings-default-fps"
                      className="select-input-sm"
                      value={defaultFps}
                      onChange={(e) => setDefaultFps(e.target.value)}
                    >
                      <option value="120">120 FPS</option>
                      <option value="60">60 FPS</option>
                      <option value="30">30 FPS</option>
                      <option value="15">15 FPS</option>
                    </select>
                  </div>

                  <div className="settings-col">
                    <label className="settings-label" htmlFor="settings-default-bitrate">
                      Bitrate de Vídeo:
                    </label>
                    <select
                      id="settings-default-bitrate"
                      className="select-input-sm"
                      value={defaultBitrate}
                      onChange={(e) => setDefaultBitrate(e.target.value)}
                    >
                      <option value="35000">35 Mbps (Ultra)</option>
                      <option value="25000">25 Mbps (Alto)</option>
                      <option value="15000">15 Mbps (Médio)</option>
                      <option value="8000">8 Mbps (Econômico)</option>
                      <option value="3000">3 Mbps</option>
                      <option value="1000">1 Mbps</option>
                    </select>
                  </div>
                </div>

                <div className="settings-row" style={{ marginTop: '14px' }}>
                  <label className="settings-switch-row" htmlFor="settings-check-cursor">
                    <div className="settings-switch-label-group">
                      <span className="settings-switch-title">Captura do Cursor do Mouse</span>
                      <span className="settings-switch-subtitle">
                        Exibir o cursor do mouse por padrão ao iniciar uma transmissão
                      </span>
                    </div>
                    <div className="modern-switch">
                      <input
                        type="checkbox"
                        id="settings-check-cursor"
                        checked={defaultCursor}
                        onChange={(e) => setDefaultCursor(e.target.checked)}
                      />
                      <span className="switch-slider"></span>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {/* TAB 5: REDE & TURN */}
            {activeTab === 'network' && (
              <div className="settings-tab-pane active" id="settings-pane-network">
                <div className="settings-pane-header">
                  <h3 className="settings-pane-title">Rede & Proteção de IP (TURN Relay)</h3>
                  <p className="settings-pane-desc">
                    Opcional: Oculte seu IP residencial encaminhando o tráfego P2P por um servidor relay.
                  </p>
                </div>

                <div className="settings-row">
                  <label className="settings-switch-row" htmlFor="settings-enable-turn">
                    <div className="settings-switch-label-group">
                      <span className="settings-switch-title">Servidor TURN / Proxy de IP</span>
                      <span className="settings-switch-subtitle">
                        Encaminhar conexões por um servidor relay para proteger seu IP residencial
                      </span>
                    </div>
                    <div className="modern-switch">
                      <input
                        type="checkbox"
                        id="settings-enable-turn"
                        checked={turnEnabled}
                        onChange={(e) => setTurnEnabled(e.target.checked)}
                      />
                      <span className="switch-slider"></span>
                    </div>
                  </label>
                </div>

                {turnEnabled && (
                  <div className="turn-config-box" id="turn-config-fields" style={{ display: 'flex', marginTop: '10px' }}>
                    <div className="settings-row">
                      <label className="settings-label" htmlFor="settings-turn-url">
                        URL do Servidor TURN:
                      </label>
                      <input
                        type="text"
                        id="settings-turn-url"
                        className="text-input-sm"
                        placeholder="turn:turn.exemplo.com:3478?transport=udp"
                        value={turnUrl}
                        onChange={(e) => setTurnUrl(e.target.value)}
                      />
                    </div>

                    <div className="settings-row-grid settings-row-grid-2col" style={{ marginTop: '8px' }}>
                      <div className="settings-col">
                        <label className="settings-label" htmlFor="settings-turn-username">
                          Usuário (Username):
                        </label>
                        <input
                          type="text"
                          id="settings-turn-username"
                          className="text-input-sm"
                          placeholder="meu-usuario"
                          value={turnUser}
                          onChange={(e) => setTurnUser(e.target.value)}
                        />
                      </div>
                      <div className="settings-col">
                        <label className="settings-label" htmlFor="settings-turn-credential">
                          Senha (Credential):
                        </label>
                        <input
                          type="password"
                          id="settings-turn-credential"
                          className="text-input-sm"
                          placeholder="••••••••"
                          value={turnCred}
                          onChange={(e) => setTurnCred(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="settings-row" style={{ marginTop: '8px' }}>
                      <label className="settings-switch-row" htmlFor="settings-turn-force-relay">
                        <div className="settings-switch-label-group">
                          <span className="settings-switch-title">Forçar Modo Relay</span>
                          <span className="settings-switch-subtitle">
                            Desativa conexões P2P diretas e força 100% do tráfego pelo servidor TURN
                          </span>
                        </div>
                        <div className="modern-switch">
                          <input
                            type="checkbox"
                            id="settings-turn-force-relay"
                            checked={turnForceRelay}
                            onChange={(e) => setTurnForceRelay(e.target.checked)}
                          />
                          <span className="switch-slider"></span>
                        </div>
                      </label>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* TAB 6: DIAGNÓSTICO & LOGS */}
            {activeTab === 'diagnostics' && (
              <div className="settings-tab-pane active" id="settings-pane-diagnostics">
                <div className="settings-pane-header">
                  <h3 className="settings-pane-title">Diagnóstico & Logs de Execução</h3>
                  <p className="settings-pane-desc">
                    O arquivo <code>latest.log</code> armazena todos os eventos, erros e dados de WebRTC em tempo real.
                  </p>
                </div>

                <div className="log-path-box">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                    <polyline points="10 9 9 9 8 9"/>
                  </svg>
                  <span className="log-path-text" id="settings-log-path-text">
                    {logPath}
                  </span>
                </div>

                <div className="log-actions-row" style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline"
                    onClick={handleOpenLatestLog}
                    title="Abrir latest.log no Bloco de Notas"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                      <polyline points="15 3 21 3 21 9"/>
                      <line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                    <span>Abrir Log (latest.log)</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-sm btn-outline"
                    onClick={handleOpenLogFolder}
                    title="Abrir pasta no Explorador de Arquivos"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                    <span>Abrir Pasta de Logs</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-sm btn-outline btn-outline-danger"
                    onClick={handleClearLog}
                    title="Limpar todo o conteúdo do latest.log"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                      <line x1="10" y1="11" x2="10" y2="17"/>
                      <line x1="14" y1="11" x2="14" y2="17"/>
                    </svg>
                    <span>Limpar Logs</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" id="btn-cancel-settings" onClick={closeModal}>
            Fechar
          </button>
          <button type="button" className="btn btn-primary" id="btn-save-settings" onClick={handleSave}>
            Salvar Configurações
          </button>
        </div>
      </div>
    </div>
  );
};
