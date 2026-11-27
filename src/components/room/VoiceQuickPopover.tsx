import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { Headphones, Mic, Settings2, Square, Volume2 } from 'lucide-react';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useDropdownPresence } from '../../hooks/useDropdownPresence';
import { modalManager } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { roomService } from '../../services/room_service';
import { listAudioDevices, onAudioDevicesChanged, type AudioDeviceLists } from '../../audio/voice_devices';
import { DEFAULT_VOICE_PREFERENCES, type NoiseSuppressionMode, type VoicePreferences } from '../../core/media/voice_preferences';
import { Select } from '../common/Select';

export interface VoiceQuickPopoverProps {
  panel: 'input' | 'output' | null;
  anchorEl: HTMLElement | null;
  onClose: () => void;
}

export const VoiceQuickPopover: React.FC<VoiceQuickPopoverProps> = ({
  panel,
  anchorEl,
  onClose,
}) => {
  useLocale();
  const {
    inVoice,
    voiceMicMuted,
    voiceInputLevelDb,
    voiceThresholdDb,
    voiceMicTestActive,
    voiceTestGateOpen,
    isLocalSpeaking,
    voicePreferences,
  } = useRoom();

  const popoverState = useMemo(
    () => (panel && anchorEl ? { panel, anchorEl } : null),
    [panel, anchorEl],
  );
  const presence = useDropdownPresence(popoverState);
  const retained = presence.value;
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [positioned, setPositioned] = useState(false);
  const [devices, setDevices] = useState<AudioDeviceLists>({ inputs: [], outputs: [] });

  useEffect(() => {
    if (!panel) return;
    let active = true;
    const refresh = (requestPerm: boolean) => {
      void listAudioDevices(requestPerm).then((lists) => {
        if (active) setDevices(lists);
      }).catch(() => {});
    };
    refresh(true);
    const unsub = onAudioDevicesChanged(() => refresh(false));
    return () => {
      active = false;
      unsub();
    };
  }, [panel]);

  useLayoutEffect(() => {
    const floating = popoverRef.current;
    if (!popoverState || !retained || !floating) return;
    let disposed = false;
    setPositioned(false);
    const update = async () => {
      const pos = await computePosition(popoverState.anchorEl, floating, {
        strategy: 'fixed',
        placement: 'bottom-end',
        middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
      });
      if (disposed) return;
      setPosition({ left: pos.x, top: pos.y });
      setPositioned(true);
    };
    const cleanup = autoUpdate(popoverState.anchorEl, floating, () => {
      void update();
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [popoverState, retained]);

  useEffect(() => {
    if (!popoverState) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (popoverState.anchorEl.contains(target)) return;
      if (target.closest('.app-select-list')) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('.app-select-list:not(.dropdown-closing)')) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      popoverState.anchorEl.focus({ preventScroll: true });
    };
    const handleBlur = () => onClose();
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, [popoverState, onClose]);

  useEffect(() => {
    if (panel !== 'input') {
      roomService.stopVoiceMicTest?.();
    }
    return () => {
      if (panel === 'input') {
        roomService.stopVoiceMicTest?.();
      }
    };
  }, [panel]);

  if (!retained) return null;

  const prefs = voicePreferences ?? roomService.voicePreferences ?? DEFAULT_VOICE_PREFERENCES;
  const updatePrefs = (patch: Partial<VoicePreferences>) => {
    const next: VoicePreferences = { ...prefs, ...patch };
    void roomService.applyVoicePreferences?.(next, true);
  };

  const inputOptions = [
    { value: 'default', label: t('voice.defaultDevice') },
    ...devices.inputs.map((device, idx) => ({
      value: device.deviceId,
      label: device.label || t('voice.inputFallbackName', { index: idx + 1 }),
    })),
    ...(prefs.inputDeviceId !== 'default' && !devices.inputs.some((d) => d.deviceId === prefs.inputDeviceId)
      ? [{ value: prefs.inputDeviceId, label: t('voice.unavailableDevice') }]
      : []),
  ];

  const outputOptions = [
    { value: 'default', label: t('voice.defaultDevice') },
    ...devices.outputs.map((device, idx) => ({
      value: device.deviceId,
      label: device.label || t('voice.outputFallbackName', { index: idx + 1 }),
    })),
    ...(prefs.outputDeviceId !== 'default' && !devices.outputs.some((d) => d.deviceId === prefs.outputDeviceId)
      ? [{ value: prefs.outputDeviceId, label: t('voice.unavailableDevice') }]
      : []),
  ];

  const meterActive = Boolean(voiceMicTestActive || (inVoice && !voiceMicMuted));
  const meterPercent = meterActive ? Math.max(0, Math.min(100, (voiceInputLevelDb ?? -100) + 100)) : 0;
  const thresholdPercent = Math.max(
    0,
    Math.min(100, (prefs.autoSensitivity ? (voiceThresholdDb ?? -50) : prefs.sensitivityDb) + 100),
  );
  const gateOpen = meterActive && (voiceMicTestActive ? Boolean(voiceTestGateOpen) : Boolean(isLocalSpeaking));

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={retained.panel === 'input' ? t('voice.inputSettingsTitle') : t('voice.outputSettingsTitle')}
      className={`voice-quick-popover ${presence.closing ? 'dropdown-closing' : ''}`}
      inert={presence.closing || undefined}
      aria-hidden={presence.closing || undefined}
      style={{
        left: position.left,
        top: position.top,
        visibility: positioned ? 'visible' : 'hidden',
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="voice-quick-popover-header">
        {retained.panel === 'input' ? <Mic size={15} aria-hidden="true" /> : <Headphones size={15} aria-hidden="true" />}
        <span>{retained.panel === 'input' ? t('voice.inputSettingsTitle') : t('voice.outputSettingsTitle')}</span>
      </div>

      {retained.panel === 'input' ? (
        <div className="voice-quick-popover-body">
          <div className="voice-quick-field">
            <label className="settings-label" htmlFor="voice-quick-input-device">
              {t('voice.inputDeviceLabel')}
            </label>
            <Select
              id="voice-quick-input-device"
              className="select-input-sm"
              value={prefs.inputDeviceId}
              options={inputOptions}
              onValueChange={(value) => updatePrefs({ inputDeviceId: value })}
            />
          </div>

          <div className="voice-quick-field">
            <div className="voice-slider-header">
              <label className="settings-label" htmlFor="voice-quick-input-volume">
                {t('voice.inputVolumeLabel')}
              </label>
              <span className="voice-slider-value">{prefs.inputVolume}%</span>
            </div>
            <input
              autoComplete="off"
              type="range"
              id="voice-quick-input-volume"
              min={0}
              max={200}
              step={1}
              value={prefs.inputVolume}
              className="settings-slider-input"
              onChange={(e) => updatePrefs({ inputVolume: Number(e.target.value) })}
              onDoubleClick={() => updatePrefs({ inputVolume: 100 })}
            />
          </div>

          <div className="voice-quick-field">
            <div className="voice-slider-header">
              <span className="settings-label">{t('voice.micTestTitle')}</span>
              <button
                type="button"
                id="btn-voice-quick-mic-test"
                className={`btn btn-sm btn-compact ${voiceMicTestActive ? 'btn-danger' : 'btn-outline'}`}
                onClick={() => {
                  if (voiceMicTestActive) {
                    roomService.stopVoiceMicTest?.();
                  } else {
                    void roomService.startVoiceMicTest?.();
                  }
                }}
              >
                {voiceMicTestActive ? (
                  <Square size={11} fill="currentColor" aria-hidden="true" />
                ) : (
                  <Mic size={11} aria-hidden="true" />
                )}
                <span>{voiceMicTestActive ? t('voice.stopMicTest') : t('voice.startMicTest')}</span>
              </button>
            </div>
            <div
              className="voice-meter-track"
              role="meter"
              aria-label={t('voice.inputMeterAria')}
              aria-valuemin={-100}
              aria-valuemax={0}
              aria-valuenow={meterActive ? (voiceInputLevelDb ?? -100) : -100}
            >
              <div
                className={`voice-meter-fill${gateOpen ? ' is-active' : ''}`}
                style={{ width: `${meterPercent}%` }}
              />
              <div className="voice-meter-threshold" style={{ left: `${thresholdPercent}%` }} aria-hidden="true" />
            </div>
          </div>

          <div className="voice-quick-field">
            <label className="settings-label" htmlFor="voice-quick-noise-suppression">
              {t('voice.noiseSuppressionLabel')}
            </label>
            <Select
              id="voice-quick-noise-suppression"
              className="select-input-sm"
              value={prefs.noiseSuppressionMode}
              options={[
                { value: 'off', label: t('voice.noiseOff') },
                { value: 'standard', label: t('voice.noiseStandard') },
                { value: 'high', label: t('voice.noiseHigh') },
              ]}
              onValueChange={(value) => updatePrefs({ noiseSuppressionMode: value as NoiseSuppressionMode })}
            />
          </div>

          <label className="settings-switch-row voice-quick-switch" htmlFor="voice-quick-auto-sensitivity">
            <span className="settings-switch-title">{t('voice.autoSensitivityLabel')}</span>
            <div className="modern-switch">
              <input
                autoComplete="off"
                type="checkbox"
                id="voice-quick-auto-sensitivity"
                checked={prefs.autoSensitivity}
                onChange={(e) => updatePrefs({ autoSensitivity: e.target.checked })}
              />
              <span className="switch-slider" />
            </div>
          </label>

          {!prefs.autoSensitivity && (
            <div className="voice-quick-field">
              <div className="voice-slider-header">
                <label className="settings-label" htmlFor="voice-quick-sensitivity">
                  {t('voice.sensitivityLabel')}
                </label>
                <span className="voice-slider-value">{t('voice.dbValue', { db: prefs.sensitivityDb })}</span>
              </div>
              <input
                autoComplete="off"
                type="range"
                id="voice-quick-sensitivity"
                min={-100}
                max={0}
                step={1}
                value={prefs.sensitivityDb}
                className="settings-slider-input"
                onChange={(e) => updatePrefs({ sensitivityDb: Number(e.target.value) })}
                onDoubleClick={() => updatePrefs({ sensitivityDb: -50 })}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="voice-quick-popover-body">
          <div className="voice-quick-field">
            <label className="settings-label" htmlFor="voice-quick-output-device">
              {t('voice.outputDeviceLabel')}
            </label>
            <Select
              id="voice-quick-output-device"
              className="select-input-sm"
              value={prefs.outputDeviceId}
              options={outputOptions}
              onValueChange={(value) => updatePrefs({ outputDeviceId: value })}
            />
          </div>

          <div className="voice-quick-field">
            <div className="voice-slider-header">
              <label className="settings-label" htmlFor="voice-quick-output-volume">
                <Volume2 size={13} aria-hidden="true" style={{ marginRight: 5, verticalAlign: '-2px' }} />
                {t('voice.outputVolumeLabel')}
              </label>
              <span className="voice-slider-value">{prefs.outputVolume}%</span>
            </div>
            <input
              autoComplete="off"
              type="range"
              id="voice-quick-output-volume"
              min={0}
              max={200}
              step={1}
              value={prefs.outputVolume}
              className="settings-slider-input"
              onChange={(e) => updatePrefs({ outputVolume: Number(e.target.value) })}
              onDoubleClick={() => updatePrefs({ outputVolume: 100 })}
            />
          </div>
        </div>
      )}

      <div className="voice-quick-popover-footer">
        <button
          type="button"
          className="btn btn-sm btn-outline voice-quick-settings-btn"
          onClick={() => {
            onClose();
            modalManager.openSettings?.('communication');
          }}
        >
          <Settings2 size={14} aria-hidden="true" />
          <span>{t('voice.openCommSettings')}</span>
        </button>
      </div>
    </div>,
    document.body,
  );
};
