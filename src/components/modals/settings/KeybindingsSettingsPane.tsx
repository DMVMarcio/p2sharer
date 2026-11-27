import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Gamepad2, Keyboard, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import {
  createDefaultGamepadProfile,
  createDefaultInputBindings,
  DEFAULT_GAMEPAD_BINDINGS,
  DEFAULT_SHORTCUTS,
  detectGamepadCapture,
  formatKeyCode,
  formatShortcutCombo,
  formatShortcutModifiers,
  GAMEPAD_DEFAULT_PROFILE_ID,
  getBindingForTarget,
  isModifierOnlyCode,
  type GamepadMappingProfile,
  type GamepadSourceBinding,
  type GamepadTargetControl,
  type InputBindingsConfig,
  type KeyRemapRule,
  type RemoteShortcutAction,
} from '../../../core/ui/input_bindings';
import { readGamepadSnapshotState } from '../../../core/stream/remote_control';
import { setVoiceShortcutCapturePaused } from '../../../services/voice_shortcuts';
import { t } from '../../../i18n';
import { ModalDialog } from '../../common/overlays/ModalDialog';
import { Select } from '../../common/inputs/Select';
import { Tooltip } from '../../common/overlays/Tooltip';
import { GamepadTargetGlyph, GamepadVisualPreview } from './GamepadVisualPreview';

interface KeybindingsSettingsPaneProps {
  value: InputBindingsConfig;
  onChange: (next: InputBindingsConfig) => void;
  subTab: 'keyboard' | 'gamepad';
  onSubTabChange: (tab: 'keyboard' | 'gamepad') => void;
}

interface DetectedGamepadInfo {
  index: number;
  id: string;
  buttons: ReadonlyArray<{ pressed: boolean; value: number }>;
  axes: ReadonlyArray<number>;
}

type ConfirmResetScope = 'shortcuts' | 'gamepadProfile' | 'allBindings';

const PREVIEW_COOLDOWN_MS = 350;

function formatGamepadBindingLabel(binding: GamepadSourceBinding | null): string {
  if (!binding) return t('inputBindings.unbound');
  if (binding.kind === 'button') {
    return t('inputBindings.rawButton', { index: binding.index });
  }
  if (binding.kind === 'hat') {
    const arrow =
      binding.dir === 'up' ? '↑' : binding.dir === 'down' ? '↓' : binding.dir === 'left' ? '←' : '→';
    return t('inputBindings.rawHat', { index: binding.index, dir: arrow });
  }
  const dirLabel = binding.dir > 0 ? '+' : '-';
  return t('inputBindings.rawAxis', { index: binding.index, dir: dirLabel });
}

function isSameGamepadBinding(
  a: GamepadSourceBinding | null,
  b: GamepadSourceBinding | null,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || a.index !== b.index) return false;
  if (a.kind === 'button') return true;
  if (a.kind === 'hat' && b.kind === 'hat') return a.dir === b.dir;
  if (a.kind === 'axis' && b.kind === 'axis') {
    return a.dir === b.dir && (a.rest ?? 0) === (b.rest ?? 0);
  }
  return false;
}

function readConnectedGamepads(): DetectedGamepadInfo[] {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
    return [];
  }
  const raw = navigator.getGamepads();
  const list: DetectedGamepadInfo[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const pad = raw[i];
    if (!pad || !pad.connected) continue;
    list.push({
      index: pad.index,
      id: (pad.id || `Gamepad ${pad.index + 1}`).trim(),
      buttons: pad.buttons.map((btn) => ({ pressed: btn.pressed, value: btn.value })),
      axes: Array.from(pad.axes),
    });
  }
  return list;
}

export const KeybindingsSettingsPane: React.FC<KeybindingsSettingsPaneProps> = ({
  value,
  onChange,
  subTab,
  onSubTabChange,
}) => {
  const subTabRefs = useRef<Partial<Record<'keyboard' | 'gamepad', HTMLButtonElement>>>({});
  const [capturingShortcut, setCapturingShortcut] = useState<RemoteShortcutAction | null>(null);
  const [heldModifiers, setHeldModifiers] = useState<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>({
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  });
  const suppressNextClickRef = useRef(false);
  const [capturingKeyField, setCapturingKeyField] = useState<{
    ruleId: string;
    side: 'from' | 'to';
  } | null>(null);

  const [selectedProfileId, setSelectedProfileId] = useState<string>(GAMEPAD_DEFAULT_PROFILE_ID);
  const [connectedPads, setConnectedPads] = useState<DetectedGamepadInfo[]>([]);
  const [capturingPadTarget, setCapturingPadTarget] = useState<{
    target: GamepadTargetControl;
    baselines: Record<number, { buttons: number[]; axes: number[] }>;
  } | null>(null);
  const [previewCooldownActive, setPreviewCooldownActive] = useState(false);
  const previewCooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmReset, setConfirmReset] = useState<ConfirmResetScope | null>(null);

  const capturingPadRef = useRef(capturingPadTarget);
  capturingPadRef.current = capturingPadTarget;
  const selectedProfileIdRef = useRef(selectedProfileId);
  selectedProfileIdRef.current = selectedProfileId;
  const valueRef = useRef(value);
  valueRef.current = value;

  const armPreviewCooldown = () => {
    setPreviewCooldownActive(true);
    if (previewCooldownTimerRef.current) clearTimeout(previewCooldownTimerRef.current);
    previewCooldownTimerRef.current = setTimeout(() => {
      previewCooldownTimerRef.current = null;
      setPreviewCooldownActive(false);
    }, PREVIEW_COOLDOWN_MS);
  };

  useEffect(() => {
    return () => {
      if (previewCooldownTimerRef.current) clearTimeout(previewCooldownTimerRef.current);
    };
  }, []);

  // Cancel active capture cleanly when switching subtabs
  useEffect(() => {
    setCapturingShortcut(null);
    setCapturingKeyField(null);
    setCapturingPadTarget(null);
    setPreviewCooldownActive(false);
  }, [subTab]);

  // Pause global voice shortcuts while capturing so an existing binding does not toggle audio during rebinding
  useEffect(() => {
    setVoiceShortcutCapturePaused(Boolean(capturingShortcut || capturingKeyField));
    return () => {
      setVoiceShortcutCapturePaused(false);
    };
  }, [capturingShortcut, capturingKeyField]);

  // Capture keyboard shortcut combos or individual key remaps (intercepts Escape before ModalDialog)
  useEffect(() => {
    if (!capturingShortcut) {
      setHeldModifiers({ ctrlKey: false, shiftKey: false, altKey: false });
    }
    if (!capturingShortcut && !capturingKeyField) return;

    const readModifierState = (event: KeyboardEvent) => ({
      ctrlKey: event.ctrlKey || event.code === 'ControlLeft' || event.code === 'ControlRight',
      shiftKey: event.shiftKey || event.code === 'ShiftLeft' || event.code === 'ShiftRight',
      altKey: event.altKey || event.code === 'AltLeft' || event.code === 'AltRight',
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      const code = event.code;
      if (!code) return;

      if (capturingShortcut) {
        if (isModifierOnlyCode(code)) {
          setHeldModifiers(readModifierState(event));
          return;
        }
        if (code === 'Escape' && !event.ctrlKey && !event.shiftKey && !event.altKey) {
          setCapturingShortcut(null);
          return;
        }
        const next = {
          ...valueRef.current,
          shortcuts: {
            ...valueRef.current.shortcuts,
            [capturingShortcut]: {
              code,
              ctrlKey: event.ctrlKey,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
            },
          },
        };
        if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
          suppressNextClickRef.current = true;
          window.setTimeout(() => {
            suppressNextClickRef.current = false;
          }, 0);
        }
        onChange(next);
        setHeldModifiers({ ctrlKey: false, shiftKey: false, altKey: false });
        setCapturingShortcut(null);
        return;
      }

      if (capturingKeyField) {
        if (event.repeat) return;
        const nextRemaps = valueRef.current.keyRemaps.map((rule) => {
          if (rule.id !== capturingKeyField.ruleId) return rule;
          return capturingKeyField.side === 'from'
            ? { ...rule, fromCode: code }
            : { ...rule, toCode: code };
        });
        onChange({ ...valueRef.current, keyRemaps: nextRemaps });
        setCapturingKeyField(null);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      if (capturingShortcut && isModifierOnlyCode(event.code)) {
        setHeldModifiers({
          ctrlKey: event.ctrlKey && event.code !== 'ControlLeft' && event.code !== 'ControlRight',
          shiftKey: event.shiftKey && event.code !== 'ShiftLeft' && event.code !== 'ShiftRight',
          altKey: event.altKey && event.code !== 'AltLeft' && event.code !== 'AltRight',
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
    };
  }, [capturingKeyField, capturingShortcut, onChange]);

  // While listening on a gamepad target, Escape cancels capture cleanly without closing the Settings modal
  useEffect(() => {
    if (!capturingPadTarget) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.code !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      setCapturingPadTarget(null);
      armPreviewCooldown();
    };
    window.addEventListener('keydown', handleEscape, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleEscape, { capture: true });
    };
  }, [capturingPadTarget]);

  // Poll connected gamepads in real time while on the Gamepad subtab
  useEffect(() => {
    if (subTab !== 'gamepad') return;
    let rafId: number | null = null;
    let disposed = false;

    const tick = () => {
      if (disposed) return;
      const pads = readConnectedGamepads();
      setConnectedPads(pads);

      const activeCapture = capturingPadRef.current;
      if (activeCapture && pads.length > 0) {
        const currentProfileId = selectedProfileIdRef.current;
        const candidates =
          currentProfileId === GAMEPAD_DEFAULT_PROFILE_ID
            ? pads
            : pads.filter((pad) => pad.id === currentProfileId);
        const searchList = candidates.length > 0 ? candidates : pads;
        for (const pad of searchList) {
          const base = activeCapture.baselines[pad.index];
          if (!base) {
            activeCapture.baselines[pad.index] = {
              buttons: pad.buttons.map((b) => (b.pressed ? Math.max(1, b.value) : b.value)),
              axes: [...pad.axes],
            };
            continue;
          }
          const matched = detectGamepadCapture(base.buttons, base.axes, pad, activeCapture.target);
          if (matched) {
            const cfg = valueRef.current;
            const existingProfile =
              cfg.gamepadProfiles[currentProfileId] ??
              createDefaultGamepadProfile(
                currentProfileId,
                currentProfileId === GAMEPAD_DEFAULT_PROFILE_ID
                  ? t('inputBindings.defaultGamepadProfile')
                  : currentProfileId,
              );
            const nextProfile: GamepadMappingProfile = {
              ...existingProfile,
              bindings: {
                ...existingProfile.bindings,
                [activeCapture.target]: matched,
              },
            };
            onChange({
              ...cfg,
              gamepadProfiles: {
                ...cfg.gamepadProfiles,
                [currentProfileId]: nextProfile,
              },
            });
            setCapturingPadTarget(null);
            armPreviewCooldown();
            break;
          }
        }
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      disposed = true;
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [onChange, subTab]);

  const profileOptions = useMemo(() => {
    const seen = new Set<string>([GAMEPAD_DEFAULT_PROFILE_ID]);
    const options: Array<{ value: string; label: string }> = [
      { value: GAMEPAD_DEFAULT_PROFILE_ID, label: t('inputBindings.defaultGamepadProfile') },
    ];
    for (const pad of connectedPads) {
      if (seen.has(pad.id)) continue;
      seen.add(pad.id);
      options.push({
        value: pad.id,
        label: `${pad.id} (${t('inputBindings.connectedTag')})`,
      });
    }
    for (const [id, profile] of Object.entries(value.gamepadProfiles)) {
      if (seen.has(id)) continue;
      seen.add(id);
      options.push({ value: id, label: profile.label || id });
    }
    return options;
  }, [connectedPads, value.gamepadProfiles]);

  const activeProfile: GamepadMappingProfile = useMemo(() => {
    return (
      value.gamepadProfiles[selectedProfileId] ??
      createDefaultGamepadProfile(
        selectedProfileId,
        selectedProfileId === GAMEPAD_DEFAULT_PROFILE_ID
          ? t('inputBindings.defaultGamepadProfile')
          : selectedProfileId,
      )
    );
  }, [selectedProfileId, value.gamepadProfiles]);

  const previewPad = useMemo(() => {
    if (selectedProfileId !== GAMEPAD_DEFAULT_PROFILE_ID) {
      return connectedPads.find((pad) => pad.id === selectedProfileId) ?? connectedPads[0] ?? null;
    }
    return connectedPads[0] ?? null;
  }, [connectedPads, selectedProfileId]);

  const previewPaused = Boolean(capturingPadTarget) || previewCooldownActive;

  const previewSnapshot = useMemo(
    () => (previewPad && !previewPaused ? readGamepadSnapshotState(previewPad, activeProfile) : null),
    [activeProfile, previewPad, previewPaused],
  );

  const updateActiveProfile = (updater: (prev: GamepadMappingProfile) => GamepadMappingProfile) => {
    const nextProfile = updater(activeProfile);
    onChange({
      ...value,
      gamepadProfiles: {
        ...value.gamepadProfiles,
        [selectedProfileId]: nextProfile,
      },
    });
  };

  const startPadCapture = (target: GamepadTargetControl) => {
    if (capturingPadTarget?.target === target) {
      setCapturingPadTarget(null);
      armPreviewCooldown();
      return;
    }
    const baselines: Record<number, { buttons: number[]; axes: number[] }> = {};
    for (const pad of connectedPads) {
      baselines[pad.index] = {
        buttons: pad.buttons.map((b) => (b.pressed ? Math.max(1, b.value) : b.value)),
        axes: [...pad.axes],
      };
    }
    setCapturingPadTarget({ target, baselines });
  };

  const executeConfirmedReset = () => {
    if (confirmReset === 'shortcuts') {
      onChange({
        ...value,
        shortcuts: {
          ...value.shortcuts,
          toggleMouseLock: DEFAULT_SHORTCUTS.toggleMouseLock
            ? { ...DEFAULT_SHORTCUTS.toggleMouseLock }
            : null,
          toggleImmersive: null,
          exitRemoteControl: null,
        },
      });
    } else if (confirmReset === 'gamepadProfile') {
      updateActiveProfile((prev) => ({
        ...prev,
        deadzone: 0,
        bindings: { ...DEFAULT_GAMEPAD_BINDINGS },
      }));
    } else if (confirmReset === 'allBindings') {
      onChange(createDefaultInputBindings());
    }
    setConfirmReset(null);
  };

  const handleAddKeyRemap = () => {
    const newId = `remap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const nextRule: KeyRemapRule = {
      id: newId,
      fromCode: 'CapsLock',
      toCode: 'ControlLeft',
    };
    onChange({
      ...value,
      keyRemaps: [...value.keyRemaps, nextRule],
    });
    setCapturingKeyField({ ruleId: newId, side: 'from' });
  };

  const remoteShortcutItems: ReadonlyArray<{ action: RemoteShortcutAction; label: string; hint: string }> = [
    {
      action: 'toggleMouseLock',
      label: t('inputBindings.shortcutMouseLock'),
      hint: t('inputBindings.shortcutMouseLockHint'),
    },
    {
      action: 'toggleImmersive',
      label: t('inputBindings.shortcutImmersive'),
      hint: t('inputBindings.shortcutImmersiveHint'),
    },
    {
      action: 'exitRemoteControl',
      label: t('inputBindings.shortcutExitControl'),
      hint: t('inputBindings.shortcutExitControlHint'),
    },
  ];

  const voiceShortcutItems: ReadonlyArray<{ action: RemoteShortcutAction; label: string; hint: string }> = [
    {
      action: 'toggleVoiceMute',
      label: t('inputBindings.shortcutVoiceMute'),
      hint: t('inputBindings.shortcutVoiceMuteHint'),
    },
    {
      action: 'toggleVoiceDeafen',
      label: t('inputBindings.shortcutVoiceDeafen'),
      hint: t('inputBindings.shortcutVoiceDeafenHint'),
    },
  ];

  const renderShortcutRow = ({ action, label, hint }: { action: RemoteShortcutAction; label: string; hint: string }) => {
    const current = value.shortcuts[action];
    const isListening = capturingShortcut === action;
    const formatted = formatShortcutCombo(current);
    const liveModParts = isListening ? formatShortcutModifiers(heldModifiers) : [];
    const listeningLabel =
      liveModParts.length > 0
        ? `${liveModParts.join(' + ')} + ...`
        : t('inputBindings.pressShortcutPrompt');
    return (
      <div className="input-binding-row" key={action}>
        <div className="input-binding-copy">
          <strong>{label}</strong>
          <small>{hint}</small>
        </div>
        <div className="input-binding-actions">
          <button
            type="button"
            id={`btn-shortcut-${action}`}
            className={`btn btn-sm input-binding-capture-btn ${isListening ? 'is-listening' : ''}`}
            onClick={() => {
              if (suppressNextClickRef.current) {
                suppressNextClickRef.current = false;
                return;
              }
              setCapturingShortcut((prev) => (prev === action ? null : action));
            }}
          >
            {isListening
              ? listeningLabel
              : formatted || t('inputBindings.unbound')}
          </button>
          {current && (
            <Tooltip content={t('inputBindings.clearAction')}>
              <button
                type="button"
                className="btn-stream-pin"
                aria-label={`${t('inputBindings.clearAction')}: ${label}`}
                onClick={() =>
                  onChange({
                    ...value,
                    shortcuts: { ...value.shortcuts, [action]: null },
                  })
                }
              >
                <X size={13} aria-hidden="true" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    );
  };

  const gamepadGroups: ReadonlyArray<{
    title: string;
    targets: ReadonlyArray<{ target: GamepadTargetControl; label: string }>;
  }> = [
    {
      title: t('inputBindings.groupLeftStick'),
      targets: [
        { target: 'lyPos', label: `${t('inputBindings.groupLeftStick')} · ${t('inputBindings.dirUp')}` },
        { target: 'lyNeg', label: `${t('inputBindings.groupLeftStick')} · ${t('inputBindings.dirDown')}` },
        { target: 'lxNeg', label: `${t('inputBindings.groupLeftStick')} · ${t('inputBindings.dirLeft')}` },
        { target: 'lxPos', label: `${t('inputBindings.groupLeftStick')} · ${t('inputBindings.dirRight')}` },
      ],
    },
    {
      title: t('inputBindings.groupRightStick'),
      targets: [
        { target: 'ryPos', label: `${t('inputBindings.groupRightStick')} · ${t('inputBindings.dirUp')}` },
        { target: 'ryNeg', label: `${t('inputBindings.groupRightStick')} · ${t('inputBindings.dirDown')}` },
        { target: 'rxNeg', label: `${t('inputBindings.groupRightStick')} · ${t('inputBindings.dirLeft')}` },
        { target: 'rxPos', label: `${t('inputBindings.groupRightStick')} · ${t('inputBindings.dirRight')}` },
      ],
    },
    {
      title: t('inputBindings.groupTriggers'),
      targets: [
        { target: 'leftTrigger', label: 'LT (L2)' },
        { target: 'rightTrigger', label: 'RT (R2)' },
      ],
    },
    {
      title: t('inputBindings.groupDpad'),
      targets: [
        { target: 'dpadUp', label: t('inputBindings.dpadUp') },
        { target: 'dpadDown', label: t('inputBindings.dpadDown') },
        { target: 'dpadLeft', label: t('inputBindings.dpadLeft') },
        { target: 'dpadRight', label: t('inputBindings.dpadRight') },
      ],
    },
    {
      title: t('inputBindings.groupButtons'),
      targets: [
        { target: 'a', label: 'A (×)' },
        { target: 'b', label: 'B (○)' },
        { target: 'x', label: 'X (□)' },
        { target: 'y', label: 'Y (△)' },
        { target: 'lb', label: 'LB (L1)' },
        { target: 'rb', label: 'RB (R1)' },
        { target: 'ls', label: t('inputBindings.btnLeftStick') },
        { target: 'rs', label: t('inputBindings.btnRightStick') },
        { target: 'back', label: 'Back / Select' },
        { target: 'start', label: 'Start / Options' },
        { target: 'guide', label: 'Guide / Home' },
      ],
    },
  ];

  const activeRawSummary = useMemo(() => {
    if (!previewPad || previewPaused) {
      return { buttons: [] as number[], axes: [] as Array<{ idx: number; val: number }> };
    }
    const buttons: number[] = [];
    previewPad.buttons.forEach((b, idx) => {
      if (b.pressed || b.value > 0.35) buttons.push(idx);
    });
    const axes: Array<{ idx: number; val: number }> = [];
    previewPad.axes.forEach((v, idx) => {
      if (Number.isFinite(v) && Math.abs(v) <= 1.08 && Math.abs(v) > 0.12) axes.push({ idx, val: v });
    });
    return { buttons, axes };
  }, [previewPad, previewPaused]);

  const confirmMessage =
    confirmReset === 'shortcuts'
      ? t('inputBindings.confirmResetShortcutsDesc')
      : confirmReset === 'gamepadProfile'
        ? t('inputBindings.confirmResetProfileDesc')
        : t('inputBindings.confirmResetAllDesc');

  return (
    <div className="settings-tab-pane active" id="settings-pane-input-bindings">
      <div className="settings-pane-header">
        <h3 className="settings-pane-title">{t('inputBindings.title')}</h3>
        <p className="settings-pane-desc">{t('inputBindings.desc')}</p>
      </div>

      <div className="sidebar-tabs settings-subtabs" role="tablist" aria-label={t('inputBindings.title')}>
        {(['keyboard', 'gamepad'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            ref={(el) => {
              if (el) subTabRefs.current[tab] = el;
              else delete subTabRefs.current[tab];
            }}
            className={`tab-btn ${subTab === tab ? 'active' : ''}`}
            role="tab"
            id={`input-bindings-tab-${tab}`}
            aria-selected={subTab === tab}
            tabIndex={subTab === tab ? 0 : -1}
            onClick={() => onSubTabChange(tab)}
            onKeyDown={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 'keyboard'
                    : event.key === 'End'
                      ? 'gamepad'
                      : tab === 'keyboard'
                        ? 'gamepad'
                        : 'keyboard';
                onSubTabChange(next);
                subTabRefs.current[next]?.focus();
              }
            }}
          >
            {tab === 'keyboard' ? <Keyboard size={14} aria-hidden="true" /> : <Gamepad2 size={14} aria-hidden="true" />}
            <span>{tab === 'keyboard' ? t('inputBindings.keyboardSubtab') : t('inputBindings.gamepadSubtab')}</span>
          </button>
        ))}
      </div>

      {subTab === 'keyboard' ? (
        <div className="input-bindings-section-stack" role="tabpanel" aria-labelledby="input-bindings-tab-keyboard">
          <div className="settings-row">
            <div className="input-bindings-section-head">
              <label className="settings-label">{t('inputBindings.shortcutsHeading')}</label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setConfirmReset('shortcuts')}
              >
                <RotateCcw size={13} aria-hidden="true" />
                <span>{t('inputBindings.resetDefaults')}</span>
              </button>
            </div>

            <div className="input-bindings-list">
              {remoteShortcutItems.map(renderShortcutRow)}
            </div>
          </div>

          <div className="settings-row">
            <div className="input-bindings-section-head">
              <div>
                <label className="settings-label">{t('inputBindings.voiceShortcutsHeading')}</label>
                <p className="input-bindings-subdesc">{t('inputBindings.voiceShortcutsDesc')}</p>
              </div>
              {(value.shortcuts.toggleVoiceMute || value.shortcuts.toggleVoiceDeafen) && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() =>
                    onChange({
                      ...value,
                      shortcuts: {
                        ...value.shortcuts,
                        toggleVoiceMute: null,
                        toggleVoiceDeafen: null,
                      },
                    })
                  }
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  <span>{t('inputBindings.clearAll')}</span>
                </button>
              )}
            </div>

            <div className="input-bindings-list">
              {voiceShortcutItems.map(renderShortcutRow)}
            </div>
          </div>

          <div className="settings-row">
            <div className="input-bindings-section-head">
              <div>
                <label className="settings-label">{t('inputBindings.keyRemapHeading')}</label>
                <p className="input-bindings-subdesc">{t('inputBindings.keyRemapDesc')}</p>
              </div>
              <div className="input-bindings-head-btns">
                {value.keyRemaps.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => onChange({ ...value, keyRemaps: [] })}
                  >
                    <RotateCcw size={13} aria-hidden="true" />
                    <span>{t('inputBindings.clearAll')}</span>
                  </button>
                )}
                <button type="button" className="btn btn-primary btn-sm" onClick={handleAddKeyRemap}>
                  <Plus size={13} aria-hidden="true" />
                  <span>{t('inputBindings.addKeyRemap')}</span>
                </button>
              </div>
            </div>

            {value.keyRemaps.length === 0 ? (
              <div className="input-bindings-empty">{t('inputBindings.noKeyRemaps')}</div>
            ) : (
              <div className="input-bindings-list">
                {value.keyRemaps.map((rule) => {
                  const listeningFrom =
                    capturingKeyField?.ruleId === rule.id && capturingKeyField.side === 'from';
                  const listeningTo =
                    capturingKeyField?.ruleId === rule.id && capturingKeyField.side === 'to';
                  return (
                    <div className="input-binding-row input-binding-remap-row" key={rule.id}>
                      <div className="input-binding-remap-pair">
                        <span className="input-binding-remap-caption">{t('inputBindings.physicalKey')}</span>
                        <button
                          type="button"
                          className={`btn btn-sm input-binding-capture-btn ${listeningFrom ? 'is-listening' : ''}`}
                          onClick={() =>
                            setCapturingKeyField((prev) =>
                              prev?.ruleId === rule.id && prev.side === 'from'
                                ? null
                                : { ruleId: rule.id, side: 'from' },
                            )
                          }
                        >
                          {listeningFrom
                            ? t('inputBindings.pressKeyPrompt')
                            : formatKeyCode(rule.fromCode)}
                        </button>
                        <span className="input-binding-arrow" aria-hidden="true">→</span>
                        <span className="input-binding-remap-caption">{t('inputBindings.remoteKey')}</span>
                        <button
                          type="button"
                          className={`btn btn-sm input-binding-capture-btn ${listeningTo ? 'is-listening' : ''}`}
                          onClick={() =>
                            setCapturingKeyField((prev) =>
                              prev?.ruleId === rule.id && prev.side === 'to'
                                ? null
                                : { ruleId: rule.id, side: 'to' },
                            )
                          }
                        >
                          {listeningTo ? t('inputBindings.pressKeyPrompt') : formatKeyCode(rule.toCode)}
                        </button>
                      </div>
                      <Tooltip content={t('inputBindings.removeRemap')}>
                        <button
                          type="button"
                          className="btn-stream-pin participants-remote-control-revoke"
                          aria-label={t('inputBindings.removeRemap')}
                          onClick={() =>
                            onChange({
                              ...value,
                              keyRemaps: value.keyRemaps.filter((entry) => entry.id !== rule.id),
                            })
                          }
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="input-bindings-section-stack" role="tabpanel" aria-labelledby="input-bindings-tab-gamepad">
          <div className="settings-row">
            <label className="settings-label" htmlFor="settings-gamepad-profile">
              {t('inputBindings.gamepadProfileLabel')}
            </label>
            <div className="input-bindings-profile-row">
              <div className="input-bindings-profile-select-wrap">
                <Select
                  id="settings-gamepad-profile"
                  className="select-input-sm"
                  value={selectedProfileId}
                  onValueChange={setSelectedProfileId}
                  options={profileOptions}
                />
              </div>
              <button
                type="button"
                className="btn btn-secondary input-bindings-profile-reset-btn"
                onClick={() => setConfirmReset('gamepadProfile')}
              >
                <RotateCcw size={14} aria-hidden="true" />
                <span>{t('inputBindings.resetDefaults')}</span>
              </button>
            </div>
          </div>

          <div className="input-bindings-gamepad-monitor">
            <GamepadVisualPreview
              snapshot={previewSnapshot}
              connected={Boolean(previewPad)}
              previewPaused={previewPaused}
              highlightedTarget={capturingPadTarget?.target ?? null}
              deadzone={activeProfile.deadzone}
            />
            {previewPad && (
              <div className="input-bindings-raw-telemetry">
                <strong>{t('inputBindings.rawTelemetryLabel')}:</strong>{' '}
                {previewPaused ? (
                  <span>{t('inputBindings.previewPausedForAssign')}</span>
                ) : activeRawSummary.buttons.length === 0 && activeRawSummary.axes.length === 0 ? (
                  <span>{t('inputBindings.rawTelemetryIdle')}</span>
                ) : (
                  <span>
                    {activeRawSummary.buttons
                      .map((idx) => t('inputBindings.rawButton', { index: idx }))
                      .join(', ')}
                    {activeRawSummary.buttons.length > 0 && activeRawSummary.axes.length > 0 ? ' · ' : ''}
                    {activeRawSummary.axes
                      .map((axis) => `E${axis.idx}: ${axis.val >= 0 ? '+' : ''}${axis.val.toFixed(2)}`)
                      .join(', ')}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="settings-row">
            <label className="settings-label" htmlFor="settings-gamepad-deadzone">
              {t('inputBindings.deadzoneLabel')}{' '}
              <output>{Math.round(activeProfile.deadzone * 100)}%</output>
            </label>
            <div className="settings-slider-container">
              <input
                autoComplete="off"
                type="range"
                id="settings-gamepad-deadzone"
                className="settings-slider-input"
                min={0}
                max={35}
                step={1}
                value={Math.round(activeProfile.deadzone * 100)}
                onChange={(event) => {
                  const pct = Number(event.target.value);
                  updateActiveProfile((prev) => ({
                    ...prev,
                    deadzone: Math.max(0, Math.min(0.35, pct / 100)),
                  }));
                }}
              />
            </div>
          </div>

          <div className="input-bindings-gamepad-groups">
            {gamepadGroups.map((group) => (
              <div className="input-bindings-gamepad-group" key={group.title}>
                <h4 className="input-bindings-group-title">{group.title}</h4>
                <div className="input-bindings-gamepad-grid">
                  {group.targets.map(({ target, label }) => {
                    const binding = getBindingForTarget(activeProfile, target);
                    const isListening = capturingPadTarget?.target === target;
                    const isDefaultBinding = isSameGamepadBinding(binding, DEFAULT_GAMEPAD_BINDINGS[target]);
                    return (
                      <div className="input-binding-row input-binding-pad-row" key={target}>
                        <Tooltip content={label}>
                          <span className="input-binding-pad-target">
                            <GamepadTargetGlyph target={target} label={label} />
                          </span>
                        </Tooltip>
                        <div className="input-binding-actions">
                          <button
                            type="button"
                            aria-label={`${label}: ${isListening ? t('inputBindings.moveGamepadPrompt') : formatGamepadBindingLabel(binding)}`}
                            className={`btn btn-sm input-binding-capture-btn ${isListening ? 'is-listening' : ''}`}
                            disabled={connectedPads.length === 0 && !isListening}
                            onClick={() => startPadCapture(target)}
                          >
                            {isListening
                              ? t('inputBindings.moveGamepadPrompt')
                              : formatGamepadBindingLabel(binding)}
                          </button>
                          <Tooltip content={t('inputBindings.resetSingleBinding')}>
                            <button
                              type="button"
                              className="btn-stream-pin"
                              disabled={isDefaultBinding}
                              aria-label={`${t('inputBindings.resetSingleBinding')}: ${label}`}
                              onClick={() =>
                                updateActiveProfile((prev) => ({
                                  ...prev,
                                  bindings: { ...prev.bindings, [target]: DEFAULT_GAMEPAD_BINDINGS[target] },
                                }))
                              }
                            >
                              <RotateCcw size={13} aria-hidden="true" />
                            </button>
                          </Tooltip>
                          {binding !== null && (
                            <Tooltip content={t('inputBindings.clearAction')}>
                              <button
                                type="button"
                                className="btn-stream-pin"
                                aria-label={`${t('inputBindings.clearAction')}: ${label}`}
                                onClick={() =>
                                  updateActiveProfile((prev) => ({
                                    ...prev,
                                    bindings: { ...prev.bindings, [target]: null },
                                  }))
                                }
                              >
                                <X size={13} aria-hidden="true" />
                              </button>
                            </Tooltip>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="input-bindings-reset-footer">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setConfirmReset('allBindings')}
            >
              <RotateCcw size={13} aria-hidden="true" />
              <span>{t('inputBindings.resetAllBindings')}</span>
            </button>
          </div>
        </div>
      )}

      {confirmReset && (
        <ModalDialog
          title={t('inputBindings.confirmResetTitle')}
          icon={<RotateCcw size={18} aria-hidden="true" />}
          onClose={() => setConfirmReset(null)}
          footer={(close) => (
            <>
              <button type="button" className="btn btn-secondary" onClick={close}>
                {t('tunnels.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  executeConfirmedReset();
                  close();
                }}
              >
                {t('inputBindings.confirmResetAction')}
              </button>
            </>
          )}
        >
          <p className="confirm-dialog-message">{confirmMessage}</p>
        </ModalDialog>
      )}
    </div>
  );
};
