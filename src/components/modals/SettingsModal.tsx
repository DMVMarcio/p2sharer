import { getLanguage, setLanguage, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { getEncoderPreference, normalizeEncoderPreference, saveEncoderPreference, type EncoderPreference, type NativeEncoderSupport } from '../../core/encoder_preferences';
import { streamDrawingLimit, STREAM_DRAWING_MAX } from '../../core/stream_pointer';
import { formatFrameRate } from '../../core/media_streams';
import { Select } from '../common/Select';
import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useModal } from '../../hooks/useModal';
import { useAppTheme, ACCENT_COLORS } from '../../hooks/useAppTheme';
import { ColorPicker } from '../common/ColorPicker';
import { TooltipButton } from '../common/TooltipButton';
import { roomService } from '../../services/room_service';
import { INITIAL_TRANSMISSION_DEFAULTS, stateStore } from '../../core/state_store';
import { soundEffects, SOUND_EVENTS, type SoundEvent } from '../../ui/sound_effects';
import { showToast } from '../../hooks/useToast';
import { ThemeMode } from '../../core/types';
import { EMOJI_PACKS, EmojiPack, getEmojiPack, saveEmojiPack } from '../../core/emoji_preferences';
import { getTransferSpeedUnit, saveTransferSpeedUnit, type TransferSpeedUnit } from '../../core/transfer_speed';
import { EmojiGlyph } from '../common/EmojiGlyph';
import { RendezvousServerEditor } from '../common/RendezvousServerEditor';
import { loadRendezvousPreferences, saveRendezvousPreferences, validateRendezvousPreferences } from '../../p2p/relay_preferences.ts';
import { isValidTurnUrl, parseTurnUrls } from '../../p2p/ice_config.ts';
import { appUpdates } from '../../services/app_updates';
import { automaticUpdateChecks, betaUpdateChecks } from '../../core/app_updates';
import { ApplicationSettings } from './ApplicationSettings';
import { useAppUpdates } from '../../hooks/useAppUpdates';

const SOUND_LABELS: Record<SoundEvent, string> = {
  get message() { return t("message.c53540ce0e08"); },
  get userJoin() { return t("message.61593d3f4699"); },
  get userLeave() { return t("message.49d982c54975"); },
  get screenShareStart() { return t("message.ea5c1b034cf4"); },
  get screenShareStop() { return t("message.89eca8829730"); },
  get watchStreamStart() { return t("message.06e5a94f9aec"); },
  get watchStreamStop() { return t("message.470b862fbd07"); },
};

export const SettingsModal: React.FC = () => {
  useLocale();
  const { closeModal, isClosing } = useModal();
  const { themeMode, accentColor, setThemeMode, setAccentColor } = useAppTheme();

  const [activeTab, setActiveTab] = useState<
    'profile' | 'application' | 'conversations' | 'appearance' | 'audio' | 'stream' | 'network' | 'diagnostics'
  >('profile');

  // Form states initialized once upon mounting
  const [nick, setNick] = useState(() => stateStore.username);
  const [language, setLanguageDraft] = useState(getLanguage);
  const [autoUpdates, setAutoUpdates] = useState(automaticUpdateChecks);
  const [betaUpdates, setBetaUpdates] = useState(betaUpdateChecks);
  const update = useAppUpdates();
  const updateBusy = ['downloading', 'installing'].includes(update.status);
  const [emojiPack, setEmojiPack] = useState<EmojiPack>(getEmojiPack);
  const [transferSpeedUnit, setTransferSpeedUnit] = useState<TransferSpeedUnit>(getTransferSpeedUnit);
  const [sfxEnabled, setSfxEnabled] = useState(() => soundEffects.getEnabled());
  const [soundEvents, setSoundEvents] = useState(() => soundEffects.getEventPreferences());
  const [sfxVolume, setSfxVolume] = useState(() => Math.round(soundEffects.getVolume() * 100));

  const [defaultRes, setDefaultRes] = useState(
    () => localStorage.getItem('p2sharer_default_res') || INITIAL_TRANSMISSION_DEFAULTS.resolution
  );
  const [rememberTransmissionSettings, setRememberTransmissionSettings] = useState(() => stateStore.rememberTransmissionSettings);
  const [defaultFps, setDefaultFps] = useState(
    () => localStorage.getItem('p2sharer_default_fps') || String(INITIAL_TRANSMISSION_DEFAULTS.fps)
  );
  const [defaultBitrate, setDefaultBitrate] = useState(
    () => localStorage.getItem('p2sharer_default_bitrate') || String(stateStore.getDefaultBitrateForResolution(defaultRes))
  );
  const [defaultQuality, setDefaultQuality] = useState(
    () => localStorage.getItem('p2sharer_default_quality') || '90'
  );
  const [participantCursors, setParticipantCursors] = useState(() => stateStore.allowParticipantCursors);
  const [drawingLimit, setDrawingLimit] = useState(() => stateStore.participantDrawingLimit);
  const [participantDrawings, setParticipantDrawings] = useState(() => stateStore.allowParticipantDrawings);
  const [participantPings, setParticipantPings] = useState(() => stateStore.allowParticipantPings);
  const [streamOptionsTab, setStreamOptionsTab] = useState<'pointing' | 'advanced'>('advanced');
  const streamOptionRefs = useRef<Partial<Record<'pointing' | 'advanced', HTMLButtonElement>>>({});
  const [encoder, setEncoder] = useState<EncoderPreference>(() => getEncoderPreference());
  const [encoderSupport, setEncoderSupport] = useState<NativeEncoderSupport | null>(null);
  const [encoderProbeDone, setEncoderProbeDone] = useState(false);
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
  const [rendezvousPreferences, setRendezvousPreferences] = useState(loadRendezvousPreferences);

  const [logPath, setLogPath] = useState(t("message.fc228b3fc51f"));

  useEffect(() => {
    invoke<string>('get_log_file_path')
      .then((path) => setLogPath(path))
      .catch(() => setLogPath(t("message.847ad4c50b0d")));
  }, []);

  useEffect(() => {
    let mounted = true;
    invoke<NativeEncoderSupport>('get_native_encoder_support').then(support => {
      if (!mounted) return;
      getEncoderPreference(support.driver_api_available);
      setEncoderSupport(support);
      setEncoder(value => normalizeEncoderPreference(value, support.driver_api_available));
    }).catch(() => {
      if (mounted) {
        getEncoderPreference(false);
        setEncoder(value => normalizeEncoderPreference(value, false));
      }
    }).finally(() => { if (mounted) setEncoderProbeDone(true); });
    return () => { mounted = false; };
  }, []);

  const handleSave = () => {
    const turnUrls = parseTurnUrls(turnUrl);
    if (turnEnabled && (turnUrls.length === 0 || turnUrls.some((url) => !isValidTurnUrl(url)))) {
      setActiveTab('network');
      showToast(t("message.9c08044c6966"));
      return;
    }
    if (turnEnabled && (!turnUser.trim() || !turnCred.trim())) {
      setActiveTab('network');
      showToast(t("message.ae469ffded19"));
      return;
    }
    const rendezvousError = validateRendezvousPreferences(rendezvousPreferences);
    if (rendezvousError) {
      setActiveTab('network');
      showToast(rendezvousError);
      return;
    }
    // Save username
    if (nick.trim()) {
      stateStore.set((s) => {
        s.username = nick.trim();
      });
      localStorage.setItem('p2sharer_username', nick.trim());
    }

    // Save SFX
    saveEmojiPack(emojiPack);
    saveTransferSpeedUnit(transferSpeedUnit);
    appUpdates.setPreferences(autoUpdates, betaUpdates);
    soundEffects.setEnabled(sfxEnabled);
    soundEffects.setEventPreferences(soundEvents);
    soundEffects.setVolume(sfxVolume / 100);

    localStorage.setItem('p2sharer_participant_cursors', String(participantCursors));
    localStorage.setItem('p2sharer_drawing_limit', String(streamDrawingLimit(drawingLimit)));
    localStorage.setItem('p2sharer_participant_drawings', String(participantDrawings));
    localStorage.setItem('p2sharer_participant_pings', String(participantPings));
    stateStore.set((s) => { s.allowParticipantCursors = participantCursors; s.allowParticipantPings = participantPings; s.allowParticipantDrawings = participantDrawings; s.participantDrawingLimit = streamDrawingLimit(drawingLimit); });
    roomService.refreshStreamPointerPermissions();

    saveEncoderPreference(encoder);

    // Save Stream defaults
    localStorage.setItem('p2sharer_remember_transmission_settings', String(rememberTransmissionSettings));
    stateStore.rememberTransmissionSettings = rememberTransmissionSettings;
    stateStore.saveTransmissionDefaults({ resolution: defaultRes, fps: Number(defaultFps),
      bitrate: Number(defaultBitrate), quality: Number(defaultQuality), cursor: defaultCursor });

    // Save TURN
    localStorage.setItem('p2sharer_turn_enabled', turnEnabled ? 'true' : 'false');
    localStorage.setItem('p2sharer_turn_url', turnUrls.join('\n'));
    localStorage.setItem('p2sharer_turn_user', turnUser.trim());
    localStorage.setItem('p2sharer_turn_cred', turnCred.trim());
    localStorage.setItem('p2sharer_turn_force_relay', turnForceRelay ? 'true' : 'false');
    saveRendezvousPreferences(rendezvousPreferences);

    setLanguage(language);
    closeModal();
    showToast(t("message.3f84cec002ac"));
  };

  const handleOpenLatestLog = async () => {
    try {
      await invoke('open_latest_log');
    } catch (err) {
      showToast(t("message.1d56d35310c9", { v0: err }));
    }
  };

  const handleOpenLogFolder = async () => {
    try {
      await invoke('open_log_folder');
    } catch (err) {
      showToast(t("message.1d56d35310c9", { v0: err }));
    }
  };

  const handleClearLog = async () => {
    try {
      await invoke('clear_log_file');
      showToast(t("message.0485a9c10162"));
    } catch (err) {
      showToast(t("message.1d56d35310c9", { v0: err }));
    }
  };

  return (
    <div className={`modal-overlay ${isClosing ? 'closing' : ''}`} id="modal-settings">
      <div className="modal-card modal-settings">
        <div className="modal-header">
          <div className="modal-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </div>
          <div>
            <h2>{t("message.76b0fb6ad189")}</h2>
            <p className="modal-subtitle">{t("message.1c345b3f945c")}</p>
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
              <span>{t("message.00d551e63dd5")}</span>
            </button>

            <button
              type="button"
              className={`settings-nav-item ${activeTab === 'conversations' ? 'active' : ''}`}
              onClick={() => setActiveTab('conversations')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 3.9a8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
              </svg>
              <span>{t("message.071f649adb47")}</span>
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
              <span>{t("message.04f9f0a78dbe")}</span>
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
              <span>{t("message.a11f1b879793")}</span>
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
              <span>{t("message.15589e9e374d")}</span>
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
              <span>{t("message.55393a891023")}</span>
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
              <span>{t("message.2a5815044d04")}</span>
            </button>

            <button type="button"
              className={`settings-nav-item ${activeTab === 'application' ? 'active' : ''}`}
              onClick={() => setActiveTab('application')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18M9 9v12" />
              </svg>
              <span>{t("message.82929ebe1446")}</span>
            </button>
          </nav>

          {/* Right Content Panes */}
          <div className="settings-tab-content-area">
            {/* TAB 1: PERFIL */}
            {activeTab === 'profile' && (
              <div className="settings-tab-pane active" id="settings-pane-profile">
                <div className="settings-pane-header">
                  <h3 className="settings-pane-title">{t("message.d16122f3087d")}</h3>
                  <p className="settings-pane-desc">{t("message.ea3a61eb13e1")}</p>
                </div>

                <div className="settings-row">
                  <label className="settings-label" htmlFor="settings-input-username">
                    {t("message.295f254de3a9")}</label>
                  <input autoComplete="off"
                    type="text"
                    id="settings-input-username"
                    className="text-input"
                    placeholder={t("message.1b92c5e9d144")}
                    maxLength={25}
                    value={nick}
                    onChange={(e) => setNick(e.target.value)}
                  />
                  <p className="field-info-text" style={{ marginTop: '4px' }}>
                    {t("message.d7eb6b69801c")}</p>
                </div>
              </div>
            )}

            {activeTab === 'application' && <ApplicationSettings language={language} onLanguageChange={setLanguageDraft} automatic={autoUpdates}
              includePrereleases={betaUpdates} onAutomaticChange={setAutoUpdates} onPrereleasesChange={setBetaUpdates} />}

            {activeTab === 'conversations' && (
              <div className="settings-tab-pane active" id="settings-pane-conversations">
                <div className="settings-pane-header">
                  <h3 className="settings-pane-title">{t("message.071f649adb47")}</h3>
                  <p className="settings-pane-desc">{t("message.5aa1310a795e")}</p>
                </div>
                <div className="settings-row">
                  <span className="settings-label" id="settings-emoji-pack-label">{t("message.17b7ebaab99f")}</span>
                  <div className="emoji-pack-options" role="radiogroup" aria-labelledby="settings-emoji-pack-label">
                    {EMOJI_PACKS.map((pack) => (
                      <button
                        key={pack.id}
                        type="button"
                        className={`emoji-pack-option ${emojiPack === pack.id ? 'active' : ''}`}
                        role="radio"
                        aria-checked={emojiPack === pack.id}
                        onClick={() => setEmojiPack(pack.id)}
                      >
                        <span className="emoji-pack-preview" aria-hidden="true">
                          <EmojiGlyph emoji="😀" pack={pack.id} size={23} />
                          <EmojiGlyph emoji="❤️" pack={pack.id} size={23} />
                          <EmojiGlyph emoji="🎉" pack={pack.id} size={23} />
                        </span>
                        <span className="emoji-pack-copy">
                          <strong>{pack.name}</strong>
                          <small>{pack.description}</small>
                        </span>
                        <span className="emoji-pack-radio" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                  <p className="field-info-text">{t("message.9c809ba3f687")}</p>
                </div>
                <div className="settings-row">
                  <label className="settings-label" htmlFor="settings-transfer-speed-unit">{t("message.68c769864a58")}</label>
                  <Select id="settings-transfer-speed-unit" className="select-input-sm"
                    value={transferSpeedUnit} onValueChange={(value) => setTransferSpeedUnit(value as TransferSpeedUnit)}
                    options={[
                      { value: 'MB', get label() { return t("message.762d9990529f"); } },
                      { value: 'Mb', get label() { return t("message.40040115a717"); } },
                    ]}
                  />
                </div>
              </div>
            )}

            {/* TAB 2: APARÊNCIA */}
            {activeTab === 'appearance' && (
              <div className="settings-tab-pane active" id="settings-pane-appearance">
                <div className="settings-pane-header">
                  <h3 className="settings-pane-title">{t("message.36ad11f3f98f")}</h3>
                  <p className="settings-pane-desc">{t("message.024e4aad422c")}</p>
                </div>

                <div className="settings-row">
                  <label className="settings-label">{t("message.fe873b85b31b")}</label>
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
                        <span>{mode === 'dark' ? t("message.fde8bb83362a") : mode === 'light' ? t("message.2f3e8dcc2464") : t("message.f150afd3c599")}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-row" style={{ marginTop: '10px' }}>
                  <label className="settings-label">{t("message.d0bc3fef4a6e")}</label>
                  <div className="accent-colors-palette" id="accent-colors-palette">
                    {ACCENT_COLORS.map((item) => (
                      <TooltipButton
                        key={item.id}
                        tooltip={item.label}
                        type="button"
                        className={`accent-swatch ${accentColor === item.id ? 'active' : ''}`}
                        style={{ '--swatch-color': item.color } as React.CSSProperties}
                        aria-label={item.label}
                        onClick={() => setAccentColor(item.id)}
                      />
                    ))}
                    <ColorPicker label={t('color.custom')} active={accentColor.startsWith('#')}
                      value={accentColor.startsWith('#') ? accentColor : ACCENT_COLORS.find(item => item.id === accentColor)?.color || '#06b6d4'}
                      onChange={setAccentColor} />
                  </div>
                </div>
              </div>
            )}

            {/* Sound settings */}
            {activeTab === 'audio' && (
              <div className="settings-tab-pane active" id="settings-pane-audio">
                <div className="settings-pane-header">
                  <h3 className="settings-pane-title">{t("message.a11f1b879793")}</h3>
                  <p className="settings-pane-desc">
                    {t("message.280e594ece53")}</p>
                </div>

                <div className="settings-row">
                  <label className="settings-switch-row" htmlFor="settings-check-sfx-enabled">
                    <div className="settings-switch-label-group">
                      <span className="settings-switch-title">{t("message.6df7357b9eee")}</span>
                      <span className="settings-switch-subtitle">
                        {t("message.b10e15979020")}</span>
                    </div>
                    <div className="modern-switch">
                      <input autoComplete="off"
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
                      {t("common.volumeLabel")}
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
                    <input autoComplete="off"
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

                <div className="settings-sound-events">
                  {SOUND_EVENTS.map((event) => (
                    <div className="settings-sound-event" key={event}>
                      <label className="settings-switch-row" htmlFor={`settings-sound-${event}`}>
                        <span className="settings-switch-title">{SOUND_LABELS[event]}</span>
                        <div className="modern-switch">
                          <input autoComplete="off" type="checkbox" id={`settings-sound-${event}`}
                            checked={soundEvents[event]} disabled={!sfxEnabled}
                            onChange={(e) => setSoundEvents((current) => ({ ...current, [event]: e.target.checked }))} />
                          <span className="switch-slider" />
                        </div>
                      </label>
                      <button type="button" className="btn btn-sm btn-outline"
                        aria-label={t("message.a93982492cdc", { v0: SOUND_LABELS[event] })}
                        onClick={() => soundEffects.preview(event, sfxVolume / 100)}>{t("message.76a30e43448f")}</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* TAB 4: TRANSMISSÃO */}
            {activeTab === 'stream' && (
              <div className="settings-tab-pane active" id="settings-pane-stream">
                <div className="settings-pane-header">
                  <h3 className="settings-pane-title">{t("message.ff7b5832d9e8")}</h3>
                  <p className="settings-pane-desc">{t("message.b1d138672f98")}</p>
                </div>

                <label className="settings-switch-row" htmlFor="settings-remember-transmission">
                  <div className="settings-switch-label-group">
                    <span className="settings-switch-title">{t("message.fc0ae2308590")}</span>
                    <span className="settings-switch-subtitle">{t("message.90555aabe768")}</span>
                  </div>
                  <div className="modern-switch">
                    <input autoComplete="off" type="checkbox" id="settings-remember-transmission"
                      checked={rememberTransmissionSettings}
                      onChange={(event) => setRememberTransmissionSettings(event.target.checked)} />
                    <span className="switch-slider" />
                  </div>
                </label>

                <div className="settings-row-grid">
                  <div className="settings-col">
                    <label className="settings-label" htmlFor="settings-default-resolution">
                      {t("message.89cda7dbc708")}</label>
                    <Select
                      id="settings-default-resolution"
                      className="select-input-sm"
                      value={defaultRes}
                      onValueChange={(value) => {
                        const newRes = value;
                        setDefaultRes(newRes);
                        setDefaultBitrate(String(stateStore.getDefaultBitrateForResolution(newRes)));
                      }}
                      options={[
                        ...(!['4k', '1440p', '1080p', '720p', '480p', '360p'].includes(defaultRes)
                          ? [{ value: defaultRes, get label() { return t("message.d935ef3eb315", { v0: defaultRes }); } }] : []),
                        { value: '4k', label: '4K (3840x2160)' },
                        { value: '1440p', label: '1440p 2K' },
                        { value: '1080p', label: '1080p Full HD' },
                        { value: '720p', label: '720p HD' },
                        { value: '480p', label: '480p SD' },
                        { value: '360p', get label() { return t("message.7e20ddcbeb68"); } },
                      ]}
                    />
                  </div>

                  <div className="settings-col">
                    <label className="settings-label" htmlFor="settings-default-fps">
                      {t("message.d4b20c1d2e76")}</label>
                    <Select
                      id="settings-default-fps"
                      className="select-input-sm"
                      value={defaultFps}
                      onValueChange={(value) => setDefaultFps(value)}
                      options={[
                        ...(!['120', '60', '30', '15'].includes(defaultFps)
                          ? [{ value: defaultFps, get label() { return t("message.d6a871b4aca9", { v0: formatFrameRate(Number(defaultFps)) }); } }] : []),
                        { value: '120', label: '120 FPS' },
                        { value: '60', label: '60 FPS' },
                        { value: '30', label: '30 FPS' },
                        { value: '15', label: '15 FPS' },
                      ]}
                    />
                  </div>

                  <div className="settings-col">
                    <label className="settings-label" htmlFor="settings-default-bitrate">
                      {t("message.1ab0b9ee51f6")}</label>
                    <Select
                      id="settings-default-bitrate"
                      className="select-input-sm"
                      value={defaultBitrate}
                      onValueChange={(value) => setDefaultBitrate(value)}
                      options={[
                        { value: '35000', get label() { return t("message.f42ed6bc24b2"); } },
                        { value: '25000', get label() { return t("message.cb779830263e"); } },
                        { value: '15000', get label() { return t("message.f92750a3986c"); } },
                        { value: '8000', get label() { return t("message.f1deac202d7a"); } },
                        { value: '3000', label: '3 Mbps' },
                        { value: '1000', label: '1 Mbps' },
                      ]}
                    />
                  </div>

                  <div className="settings-col">
                    <label className="settings-label" htmlFor="settings-default-quality">
                      {t("message.c3d090c6e04f")}</label>
                    <Select
                      id="settings-default-quality"
                      className="select-input-sm"
                      value={defaultQuality}
                      onValueChange={(value) => setDefaultQuality(value)}
                      options={[
                        { value: '95', get label() { return t("message.f11b8650575e"); } },
                        { value: '90', get label() { return t("message.41bd9b5558ed"); } },
                        { value: '85', get label() { return t("message.0254f0dbf2af"); } },
                        { value: '75', get label() { return t("message.9df00552db6a"); } },
                      ]}
                    />
                  </div>
                </div>

                <div className="settings-row" style={{ marginTop: '14px' }}>
                  <div className="theme-mode-pills" role="tablist" aria-label={t("message.f45b43b042cf")}>
                    {(['advanced', 'pointing'] as const).map(tab => <button key={tab} type="button"
                      ref={element => { if (element) streamOptionRefs.current[tab] = element; else delete streamOptionRefs.current[tab]; }}
                      className={`pill-btn ${streamOptionsTab === tab ? 'active' : ''}`} role="tab"
                      id={`stream-options-${tab}`} aria-selected={streamOptionsTab === tab}
                      aria-controls={`stream-options-panel-${tab}`} tabIndex={streamOptionsTab === tab ? 0 : -1}
                      onClick={() => setStreamOptionsTab(tab)} onKeyDown={event => {
                        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                          event.preventDefault();
                          const next = event.key === 'Home' ? 'advanced' : event.key === 'End' ? 'pointing' : tab === 'pointing' ? 'advanced' : 'pointing';
                          setStreamOptionsTab(next);
                          streamOptionRefs.current[next]?.focus();
                        }
                      }}>{tab === 'pointing' ? t("message.fc4d44253740") : t("message.5427a20ed7f7")}</button>)}
                  </div>
                  {streamOptionsTab === 'pointing' && <div className="settings-row settings-options-panel" role="tabpanel" id="stream-options-panel-pointing" aria-labelledby="stream-options-pointing">
                  {[
                    { id: 'participant-cursors', get label() { return t("message.0cdd1ad3fe1c"); }, description: t("message.6052f362cfdc"), checked: participantCursors, change: setParticipantCursors },
                    { id: 'participant-drawings', get label() { return t("message.cda3e4551d5a"); }, description: t("message.2254b260a6cc"), checked: participantDrawings, change: setParticipantDrawings },
                    { id: 'participant-pings', get label() { return t("message.ee4c7260df68"); }, description: t("message.865d9327256a"), checked: participantPings, change: setParticipantPings },
                  ].map((option) => <label className="settings-switch-row" htmlFor={option.id} key={option.id}>
                    <div className="settings-switch-label-group">
                      <span className="settings-switch-title">{option.label}</span>
                      <span className="settings-switch-subtitle">{option.description}</span>
                    </div>
                    <div className="modern-switch">
                      <input autoComplete="off" type="checkbox" id={option.id} checked={option.checked} disabled={option.id !== 'participant-cursors' && !participantCursors}
                        onChange={(event) => option.change(event.target.checked)} />
                      <span className="switch-slider" />
                    </div>
                  </label>)}
                  <div className="settings-row">
                    <label className="settings-label" htmlFor="settings-drawing-limit">{t("message.0156c3e1a240")} <output>{drawingLimit}</output></label>
                    <div className="settings-slider-container">
                      <input autoComplete="off" type="range" id="settings-drawing-limit" min={1} max={STREAM_DRAWING_MAX} step={1}
                        className="settings-slider-input" value={drawingLimit} disabled={!participantCursors || !participantDrawings}
                        onChange={event => setDrawingLimit(streamDrawingLimit(Number(event.target.value)))} />
                    </div>
                  </div>
                  </div>}
                  {streamOptionsTab === 'advanced' && <div className="settings-row settings-options-panel" role="tabpanel" id="stream-options-panel-advanced" aria-labelledby="stream-options-advanced">
                  <div className="settings-row">
                    <label className="settings-label" htmlFor="settings-video-encoder">{t("message.e13520183b92")}</label>
                    <Select id="settings-video-encoder" className="select-input-sm" value={encoder}
                      disabled={!encoderProbeDone} onValueChange={value => setEncoder(value as EncoderPreference)}
                      options={[
                        { value: 'auto', get label() { return t("message.2e0fd9488d50"); } },
                        { value: 'generic', get label() { return t("message.f574fa78f3a3"); } },
                        ...(encoderSupport?.driver_api_available ? [{ value: 'nvenc', label: 'NVIDIA NVENC' }] : []),
                      ]} />

                  </div>
                  <label className="settings-switch-row" htmlFor="settings-check-cursor">
                    <div className="settings-switch-label-group">
                      <span className="settings-switch-title">{t("message.dc0fc785c2e0")}</span>
                      <span className="settings-switch-subtitle">
                        {t("message.792b3073212b")}</span>
                    </div>
                    <div className="modern-switch">
                      <input autoComplete="off"
                        type="checkbox"
                        id="settings-check-cursor"
                        checked={defaultCursor}
                        onChange={(e) => setDefaultCursor(e.target.checked)}
                      />
                      <span className="switch-slider"></span>
                    </div>
                  </label>
                  </div>}
                </div>
              </div>
            )}

            {/* TAB 5: REDE & TURN */}
            {activeTab === 'network' && (
              <div className="settings-tab-pane active" id="settings-pane-network">
                <div className="settings-pane-header">
                  <h3 className="settings-pane-title">{t("message.da60254327a5")}</h3>
                  <p className="settings-pane-desc">
                    {t("message.56c0bef18e07")}</p>
                </div>

                <div className="settings-row">
                  <label className="settings-switch-row" htmlFor="settings-enable-turn">
                    <div className="settings-switch-label-group">
                      <span className="settings-switch-title">{t("message.4f24b84b085c")}</span>
                      <span className="settings-switch-subtitle">
                        {t("message.1f0bc36a803d")}</span>
                    </div>
                    <div className="modern-switch">
                      <input autoComplete="off"
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
                        {t("message.87949ccf803a")}</label>
                      <textarea autoComplete="off"
                        id="settings-turn-url"
                        className="text-input-sm"
                        rows={3}
                        placeholder={t("message.4bfa478047d1")}
                        value={turnUrl}
                        onChange={(e) => setTurnUrl(e.target.value)}
                      />
                    </div>

                    <div className="settings-row-grid settings-row-grid-2col" style={{ marginTop: '8px' }}>
                      <div className="settings-col">
                        <label className="settings-label" htmlFor="settings-turn-username">
                          {t("message.e69e86de6c04")}</label>
                        <input autoComplete="off"
                          type="text"
                          id="settings-turn-username"
                          className="text-input-sm"
                          placeholder={t("message.3ff4bbfe65d6")}
                          value={turnUser}
                          onChange={(e) => setTurnUser(e.target.value)}
                        />
                      </div>
                      <div className="settings-col">
                        <label className="settings-label" htmlFor="settings-turn-credential">
                          {t("message.9c47a12d5703")}</label>
                        <input autoComplete="off"
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
                          <span className="settings-switch-title">{t("message.3fa5703adf75")}</span>
                          <span className="settings-switch-subtitle">
                            {t("message.09e50e8c3aeb")}</span>
                        </div>
                        <div className="modern-switch">
                          <input autoComplete="off"
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
                <div className="settings-pane-header rendezvous-header">
                  <h3 className="settings-pane-title">{t("message.59b7d7c38320")}</h3>
                  <p className="settings-pane-desc">
                    {t("message.2cbfd880ac6f")}</p>
                </div>
                <RendezvousServerEditor preferences={rendezvousPreferences} onChange={setRendezvousPreferences} />
              </div>
            )}

            {/* TAB 6: DIAGNÓSTICO & LOGS */}
            {activeTab === 'diagnostics' && (
              <div className="settings-tab-pane active" id="settings-pane-diagnostics">
                <div className="settings-pane-header">
                  <h3 className="settings-pane-title">{t("message.b750226b7613")}</h3>
                  <p className="settings-pane-desc">
                    {t("message.d8f3f3836074")}</p>
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
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                      <polyline points="15 3 21 3 21 9"/>
                      <line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                    <span>{t("message.27d6c20d47a8")}</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-sm btn-outline"
                    onClick={handleOpenLogFolder}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                    <span>{t("message.39b7a909f8f5")}</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-sm btn-outline btn-outline-danger"
                    onClick={handleClearLog}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                      <line x1="10" y1="11" x2="10" y2="17"/>
                      <line x1="14" y1="11" x2="14" y2="17"/>
                    </svg>
                    <span>{t("message.64ac69ca075b")}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" id="btn-cancel-settings" onClick={closeModal}>
            {t("message.0f2bd88ef0ac")}</button>
          <button type="button" className="btn btn-primary" id="btn-save-settings" disabled={updateBusy} onClick={handleSave}>
            {t("message.f28b2e26db4d")}</button>
        </div>
      </div>
    </div>
  );
};
