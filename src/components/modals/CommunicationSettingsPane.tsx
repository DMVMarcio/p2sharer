import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Headphones, Mic, ShieldCheck, Square, Volume2 } from 'lucide-react';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { Select } from '../common/Select';
import { listAudioDevices, onAudioDevicesChanged, type AudioDeviceLists } from '../../audio/voice_devices';
import { voiceManager } from '../../audio/voice_manager';
import type { NoiseSuppressionMode, VoicePreferences } from '../../core/voice_preferences';

interface CommunicationSettingsPaneProps {
  value: VoicePreferences;
  onChange: (next: VoicePreferences) => void;
  disabled?: boolean;
}

export const CommunicationSettingsPane: React.FC<CommunicationSettingsPaneProps> = ({
  value,
  onChange,
  disabled = false,
}) => {
  useLocale();
  const [devices, setDevices] = useState<AudioDeviceLists>({ inputs: [], outputs: [] });

  const subscribeVoice = React.useCallback((listener: () => void) => voiceManager.subscribe(listener), []);
  const getVoiceSnap = React.useCallback(() => voiceManager.getSnapshot(), []);
  const voiceSnap = useSyncExternalStore(subscribeVoice, getVoiceSnap, getVoiceSnap);

  useEffect(() => {
    let active = true;
    const refresh = (requestPermission: boolean) => {
      void listAudioDevices(requestPermission).then((lists) => {
        if (active) setDevices(lists);
      }).catch(() => {});
    };
    refresh(true);
    const unsub = onAudioDevicesChanged(() => refresh(false));
    return () => {
      active = false;
      unsub();
    };
  }, []);

  useEffect(() => {
    if (voiceSnap.micTestActive) {
      void voiceManager.updateMicTest(value);
    }
  }, [value, voiceSnap.micTestActive]);

  useEffect(() => {
    return () => {
      voiceManager.stopMicTest();
    };
  }, []);

  const update = (patch: Partial<VoicePreferences>) => {
    onChange({ ...value, ...patch });
  };

  const toggleMicTest = async () => {
    if (voiceSnap.micTestActive) {
      voiceManager.stopMicTest();
      return;
    }
    try {
      await voiceManager.startMicTest(value);
    } catch {
      voiceManager.stopMicTest();
    }
  };

  const inputOptions = [
    { value: 'default', label: t('voice.defaultDevice') },
    ...devices.inputs.map((device, idx) => ({
      value: device.deviceId,
      label: device.label || t('voice.inputFallbackName', { index: idx + 1 }),
    })),
    ...(value.inputDeviceId !== 'default' && !devices.inputs.some((d) => d.deviceId === value.inputDeviceId)
      ? [{ value: value.inputDeviceId, label: t('voice.unavailableDevice') }]
      : []),
  ];

  const outputOptions = [
    { value: 'default', label: t('voice.defaultDevice') },
    ...devices.outputs.map((device, idx) => ({
      value: device.deviceId,
      label: device.label || t('voice.outputFallbackName', { index: idx + 1 }),
    })),
    ...(value.outputDeviceId !== 'default' && !devices.outputs.some((d) => d.deviceId === value.outputDeviceId)
      ? [{ value: value.outputDeviceId, label: t('voice.unavailableDevice') }]
      : []),
  ];

  const meterActive = voiceSnap.micTestActive || voiceSnap.inVoice;
  const meterPercent = meterActive ? Math.max(0, Math.min(100, voiceSnap.inputLevelDb + 100)) : 0;
  const effectiveThreshold = value.autoSensitivity ? voiceSnap.effectiveThresholdDb : value.sensitivityDb;
  const thresholdPercent = Math.max(0, Math.min(100, effectiveThreshold + 100));
  const gateOpen = meterActive && (voiceSnap.micTestActive ? voiceSnap.isTestGateOpen : voiceSnap.isLocalSpeaking);

  return (
    <div className="settings-tab-pane active" id="settings-pane-communication">
      <div className="settings-pane-header">
        <h3 className="settings-pane-title">{t('voice.settingsTitle')}</h3>
        <p className="settings-pane-desc">{t('voice.settingsDesc')}</p>
      </div>

      {/* Devices & 0-200% Volumes */}
      <div className="settings-row-grid">
        <div className="settings-col">
          <label className="settings-label" htmlFor="settings-voice-input-device">
            <Mic size={13} aria-hidden="true" style={{ marginRight: 5, verticalAlign: '-2px' }} />
            {t('voice.inputDeviceLabel')}
          </label>
          <Select
            id="settings-voice-input-device"
            className="select-input-sm"
            disabled={disabled}
            value={value.inputDeviceId}
            options={inputOptions}
            onValueChange={(nextId) => update({ inputDeviceId: nextId })}
          />
        </div>

        <div className="settings-col">
          <label className="settings-label" htmlFor="settings-voice-output-device">
            <Headphones size={13} aria-hidden="true" style={{ marginRight: 5, verticalAlign: '-2px' }} />
            {t('voice.outputDeviceLabel')}
          </label>
          <Select
            id="settings-voice-output-device"
            className="select-input-sm"
            disabled={disabled}
            value={value.outputDeviceId}
            options={outputOptions}
            onValueChange={(nextId) => update({ outputDeviceId: nextId })}
          />
        </div>
      </div>

      <div className="settings-row-grid">
        <div className="settings-col">
          <div className="voice-slider-header">
            <label className="settings-label" htmlFor="settings-voice-input-volume">
              {t('voice.inputVolumeLabel')}
            </label>
            <span className="voice-slider-value" id="settings-voice-input-volume-label">
              {value.inputVolume}%
            </span>
          </div>
          <div className="settings-slider-container voice-slider-row">
            <input
              autoComplete="off"
              type="range"
              id="settings-voice-input-volume"
              min={0}
              max={200}
              step={1}
              disabled={disabled}
              value={value.inputVolume}
              className="settings-slider-input"
              onChange={(e) => update({ inputVolume: Number(e.target.value) })}
              onDoubleClick={() => { if (!disabled) update({ inputVolume: 100 }); }}
            />
          </div>
        </div>

        <div className="settings-col">
          <div className="voice-slider-header">
            <label className="settings-label" htmlFor="settings-voice-output-volume">
              <Volume2 size={13} aria-hidden="true" style={{ marginRight: 5, verticalAlign: '-2px' }} />
              {t('voice.outputVolumeLabel')}
            </label>
            <span className="voice-slider-value" id="settings-voice-output-volume-label">
              {value.outputVolume}%
            </span>
          </div>
          <div className="settings-slider-container voice-slider-row">
            <input
              autoComplete="off"
              type="range"
              id="settings-voice-output-volume"
              min={0}
              max={200}
              step={1}
              disabled={disabled}
              value={value.outputVolume}
              className="settings-slider-input"
              onChange={(e) => update({ outputVolume: Number(e.target.value) })}
              onDoubleClick={() => { if (!disabled) update({ outputVolume: 100 }); }}
            />
          </div>
        </div>
      </div>

      {/* Mic Test & Input Sensitivity */}
      <div className="settings-row">
        <div className="voice-test-header">
          <div className="settings-switch-label-group">
            <span className="settings-switch-title">{t('voice.micTestTitle')}</span>
            <span className="settings-switch-subtitle">{t('voice.micTestDesc')}</span>
          </div>
          <button
            type="button"
            id="btn-voice-mic-test"
            disabled={disabled}
            className={`btn btn-sm ${voiceSnap.micTestActive ? 'btn-danger' : 'btn-outline'}`}
            onClick={() => void toggleMicTest()}
          >
            {voiceSnap.micTestActive ? <Square size={13} fill="currentColor" aria-hidden="true" /> : <Mic size={13} aria-hidden="true" />}
            <span>{voiceSnap.micTestActive ? t('voice.stopMicTest') : t('voice.startMicTest')}</span>
          </button>
        </div>

        <div
          className="voice-meter-track voice-meter-track-lg"
          role="meter"
          aria-label={t('voice.inputMeterAria')}
          aria-valuemin={-100}
          aria-valuemax={0}
          aria-valuenow={meterActive ? voiceSnap.inputLevelDb : -100}
        >
          <div
            className={`voice-meter-fill${gateOpen ? ' is-active' : ''}`}
            style={{ width: `${meterPercent}%` }}
          />
          <div
            className="voice-meter-threshold"
            style={{ left: `${thresholdPercent}%` }}
            aria-hidden="true"
          />
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-switch-row" htmlFor="settings-voice-auto-sensitivity">
          <div className="settings-switch-label-group">
            <span className="settings-switch-title">{t('voice.autoSensitivityLabel')}</span>
            <span className="settings-switch-subtitle">{t('voice.autoSensitivityDesc')}</span>
          </div>
          <div className="modern-switch">
            <input
              autoComplete="off"
              type="checkbox"
              id="settings-voice-auto-sensitivity"
              checked={value.autoSensitivity}
              disabled={disabled}
              onChange={(e) => update({ autoSensitivity: e.target.checked })}
            />
            <span className="switch-slider" />
          </div>
        </label>
      </div>

      <div className="settings-row">
        <div className="voice-slider-header">
          <label className="settings-label" htmlFor="settings-voice-sensitivity">
            {t('voice.sensitivityLabel')}
          </label>
          <span className="voice-slider-value" id="settings-voice-sensitivity-label">
            {t('voice.dbValue', { db: effectiveThreshold })}
          </span>
        </div>
        <div className="settings-slider-container">
          <input
            autoComplete="off"
            type="range"
            id="settings-voice-sensitivity"
            min={-100}
            max={0}
            step={1}
            disabled={disabled || value.autoSensitivity}
            value={value.sensitivityDb}
            className="settings-slider-input"
            onChange={(e) => update({ sensitivityDb: Number(e.target.value) })}
            onDoubleClick={() => { if (!disabled && !value.autoSensitivity) update({ sensitivityDb: -50 }); }}
          />
        </div>
      </div>

      {/* Noise Suppression & Voice Processing */}
      <div className="settings-row">
        <label className="settings-label" htmlFor="settings-voice-noise-suppression">
          <ShieldCheck size={13} aria-hidden="true" style={{ marginRight: 5, verticalAlign: '-2px' }} />
          {t('voice.noiseSuppressionLabel')}
        </label>
        <Select
          id="settings-voice-noise-suppression"
          className="select-input-sm"
          disabled={disabled}
          value={value.noiseSuppressionMode}
          options={[
            { value: 'off', label: t('voice.noiseOff') },
            { value: 'standard', label: t('voice.noiseStandard') },
            { value: 'high', label: t('voice.noiseHigh') },
          ]}
          onValueChange={(nextMode) => update({ noiseSuppressionMode: nextMode as NoiseSuppressionMode })}
        />
        <p className="field-info-text">{t('voice.noiseSuppressionDesc')}</p>
      </div>

      <div className="settings-row">
        <label className="settings-switch-row" htmlFor="settings-voice-echo-cancellation">
          <div className="settings-switch-label-group">
            <span className="settings-switch-title">{t('voice.echoCancellationLabel')}</span>
            <span className="settings-switch-subtitle">{t('voice.echoCancellationDesc')}</span>
          </div>
          <div className="modern-switch">
            <input
              autoComplete="off"
              type="checkbox"
              id="settings-voice-echo-cancellation"
              checked={value.echoCancellation}
              disabled={disabled}
              onChange={(e) => update({ echoCancellation: e.target.checked })}
            />
            <span className="switch-slider" />
          </div>
        </label>

        <label className="settings-switch-row" htmlFor="settings-voice-agc">
          <div className="settings-switch-label-group">
            <span className="settings-switch-title">{t('voice.autoGainLabel')}</span>
            <span className="settings-switch-subtitle">{t('voice.autoGainDesc')}</span>
          </div>
          <div className="modern-switch">
            <input
              autoComplete="off"
              type="checkbox"
              id="settings-voice-agc"
              checked={value.autoGainControl}
              disabled={disabled}
              onChange={(e) => update({ autoGainControl: e.target.checked })}
            />
            <span className="switch-slider" />
          </div>
        </label>
      </div>
    </div>
  );
};
