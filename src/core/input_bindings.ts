export type RemoteShortcutAction =
  | 'toggleMouseLock'
  | 'toggleImmersive'
  | 'exitRemoteControl'
  | 'toggleVoiceMute'
  | 'toggleVoiceDeafen';

export type VoiceShortcutAction = 'toggleVoiceMute' | 'toggleVoiceDeafen';

export interface ShortcutBinding {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface KeyRemapRule {
  id: string;
  fromCode: string;
  toCode: string;
}

export type GamepadTargetControl =
  | 'lxNeg'
  | 'lxPos'
  | 'lyPos'
  | 'lyNeg'
  | 'rxNeg'
  | 'rxPos'
  | 'ryPos'
  | 'ryNeg'
  | 'leftTrigger'
  | 'rightTrigger'
  | 'dpadUp'
  | 'dpadDown'
  | 'dpadLeft'
  | 'dpadRight'
  | 'a'
  | 'b'
  | 'x'
  | 'y'
  | 'lb'
  | 'rb'
  | 'back'
  | 'start'
  | 'guide'
  | 'ls'
  | 'rs';

export type GamepadHatDirection = 'up' | 'down' | 'left' | 'right';

export type GamepadSourceBinding =
  | { kind: 'button'; index: number }
  | { kind: 'axis'; index: number; dir: 1 | -1; rest?: number }
  | { kind: 'hat'; index: number; dir: GamepadHatDirection };

export interface GamepadMappingProfile {
  id: string;
  label: string;
  deadzone: number;
  bindings: Partial<Record<GamepadTargetControl, GamepadSourceBinding | null>>;
}

export interface InputBindingsConfig {
  shortcuts: Record<RemoteShortcutAction, ShortcutBinding | null>;
  keyRemaps: KeyRemapRule[];
  gamepadProfiles: Record<string, GamepadMappingProfile>;
}

export interface GamepadInputSourceLike {
  index: number;
  id?: string;
  connected?: boolean;
  buttons: ReadonlyArray<{ pressed: boolean; value: number }>;
  axes: ReadonlyArray<number>;
}

export const GAMEPAD_DEFAULT_PROFILE_ID = '__default__';
const INPUT_BINDINGS_STORAGE_KEY = 'p2sharer_input_bindings_v1';

export const DEFAULT_SHORTCUTS: Record<RemoteShortcutAction, ShortcutBinding | null> = {
  toggleMouseLock: { code: 'KeyM', ctrlKey: true, shiftKey: true, altKey: false },
  toggleImmersive: null,
  exitRemoteControl: null,
  toggleVoiceMute: null,
  toggleVoiceDeafen: null,
};

export const DEFAULT_GAMEPAD_BINDINGS: Record<GamepadTargetControl, GamepadSourceBinding> = {
  lxNeg: { kind: 'axis', index: 0, dir: -1, rest: 0 },
  lxPos: { kind: 'axis', index: 0, dir: 1, rest: 0 },
  lyPos: { kind: 'axis', index: 1, dir: -1, rest: 0 },
  lyNeg: { kind: 'axis', index: 1, dir: 1, rest: 0 },
  rxNeg: { kind: 'axis', index: 2, dir: -1, rest: 0 },
  rxPos: { kind: 'axis', index: 2, dir: 1, rest: 0 },
  ryPos: { kind: 'axis', index: 3, dir: -1, rest: 0 },
  ryNeg: { kind: 'axis', index: 3, dir: 1, rest: 0 },
  leftTrigger: { kind: 'button', index: 6 },
  rightTrigger: { kind: 'button', index: 7 },
  dpadUp: { kind: 'button', index: 12 },
  dpadDown: { kind: 'button', index: 13 },
  dpadLeft: { kind: 'button', index: 14 },
  dpadRight: { kind: 'button', index: 15 },
  start: { kind: 'button', index: 9 },
  back: { kind: 'button', index: 8 },
  ls: { kind: 'button', index: 10 },
  rs: { kind: 'button', index: 11 },
  lb: { kind: 'button', index: 4 },
  rb: { kind: 'button', index: 5 },
  guide: { kind: 'button', index: 16 },
  a: { kind: 'button', index: 0 },
  b: { kind: 'button', index: 1 },
  x: { kind: 'button', index: 2 },
  y: { kind: 'button', index: 3 },
};

export const GAMEPAD_DIGITAL_TARGETS: ReadonlyArray<{
  control: Exclude<
    GamepadTargetControl,
    'lxNeg' | 'lxPos' | 'lyPos' | 'lyNeg' | 'rxNeg' | 'rxPos' | 'ryPos' | 'ryNeg' | 'leftTrigger' | 'rightTrigger'
  >;
  bit: number;
}> = [
  { control: 'dpadUp', bit: 0x0001 },
  { control: 'dpadDown', bit: 0x0002 },
  { control: 'dpadLeft', bit: 0x0004 },
  { control: 'dpadRight', bit: 0x0008 },
  { control: 'start', bit: 0x0010 },
  { control: 'back', bit: 0x0020 },
  { control: 'ls', bit: 0x0040 },
  { control: 'rs', bit: 0x0080 },
  { control: 'lb', bit: 0x0100 },
  { control: 'rb', bit: 0x0200 },
  { control: 'guide', bit: 0x0400 },
  { control: 'a', bit: 0x1000 },
  { control: 'b', bit: 0x2000 },
  { control: 'x', bit: 0x4000 },
  { control: 'y', bit: 0x8000 },
];

export const COMMON_SPECIAL_KEY_CODES: ReadonlyArray<string> = [
  'Escape',
  'Tab',
  'CapsLock',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'ContextMenu',
  'Space',
  'Enter',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PrintScreen',
  'Pause',
];

export function createDefaultGamepadProfile(
  id = GAMEPAD_DEFAULT_PROFILE_ID,
  label = 'Default',
): GamepadMappingProfile {
  return {
    id,
    label,
    deadzone: 0,
    bindings: { ...DEFAULT_GAMEPAD_BINDINGS },
  };
}

export function createDefaultInputBindings(): InputBindingsConfig {
  return {
    shortcuts: {
      toggleMouseLock: DEFAULT_SHORTCUTS.toggleMouseLock ? { ...DEFAULT_SHORTCUTS.toggleMouseLock } : null,
      toggleImmersive: null,
      exitRemoteControl: null,
      toggleVoiceMute: null,
      toggleVoiceDeafen: null,
    },
    keyRemaps: [],
    gamepadProfiles: {
      [GAMEPAD_DEFAULT_PROFILE_ID]: createDefaultGamepadProfile(),
    },
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function sanitizeShortcut(raw: unknown): ShortcutBinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.code !== 'string' || !obj.code.trim() || obj.code.length > 48) return null;
  return {
    code: obj.code,
    ctrlKey: Boolean(obj.ctrlKey),
    shiftKey: Boolean(obj.shiftKey),
    altKey: Boolean(obj.altKey),
  };
}

function sanitizeGamepadSource(raw: unknown): GamepadSourceBinding | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (
    obj.kind === 'button' &&
    typeof obj.index === 'number' &&
    Number.isInteger(obj.index) &&
    obj.index >= 0 &&
    obj.index <= 64
  ) {
    return { kind: 'button', index: obj.index };
  }
  if (
    obj.kind === 'axis' &&
    typeof obj.index === 'number' &&
    Number.isInteger(obj.index) &&
    obj.index >= 0 &&
    obj.index <= 32 &&
    (obj.dir === 1 || obj.dir === -1)
  ) {
    const rest =
      typeof obj.rest === 'number' && Number.isFinite(obj.rest)
        ? Math.max(-1, Math.min(1, obj.rest))
        : 0;
    return { kind: 'axis', index: obj.index, dir: obj.dir, rest };
  }
  if (
    obj.kind === 'hat' &&
    typeof obj.index === 'number' &&
    Number.isInteger(obj.index) &&
    obj.index >= 0 &&
    obj.index <= 32 &&
    (obj.dir === 'up' || obj.dir === 'down' || obj.dir === 'left' || obj.dir === 'right')
  ) {
    return { kind: 'hat', index: obj.index, dir: obj.dir };
  }
  return undefined;
}

export function sanitizeInputBindingsConfig(raw: unknown): InputBindingsConfig {
  const base = createDefaultInputBindings();
  if (!raw || typeof raw !== 'object') return base;
  const obj = raw as Record<string, unknown>;

  if (obj.shortcuts && typeof obj.shortcuts === 'object') {
    const rawShortcuts = obj.shortcuts as Record<string, unknown>;
    ([
      'toggleMouseLock',
      'toggleImmersive',
      'exitRemoteControl',
      'toggleVoiceMute',
      'toggleVoiceDeafen',
    ] as const).forEach((action) => {
      if (action in rawShortcuts) {
        base.shortcuts[action] = sanitizeShortcut(rawShortcuts[action]);
      }
    });
  }

  if (Array.isArray(obj.keyRemaps)) {
    const seenFrom = new Set<string>();
    const remaps: KeyRemapRule[] = [];
    for (const item of obj.keyRemaps) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const fromCode = typeof entry.fromCode === 'string' ? entry.fromCode.trim() : '';
      const toCode = typeof entry.toCode === 'string' ? entry.toCode.trim() : '';
      if (!fromCode || !toCode || fromCode.length > 48 || toCode.length > 48 || seenFrom.has(fromCode)) {
        continue;
      }
      seenFrom.add(fromCode);
      const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id : `remap-${fromCode}`;
      remaps.push({ id, fromCode, toCode });
    }
    base.keyRemaps = remaps;
  }

  if (obj.gamepadProfiles && typeof obj.gamepadProfiles === 'object') {
    const rawProfiles = obj.gamepadProfiles as Record<string, unknown>;
    for (const [id, profileRaw] of Object.entries(rawProfiles)) {
      if (!id || typeof profileRaw !== 'object' || !profileRaw) continue;
      const pObj = profileRaw as Record<string, unknown>;
      const profile = createDefaultGamepadProfile(
        id,
        typeof pObj.label === 'string' && pObj.label.trim() ? pObj.label.slice(0, 120) : id,
      );
      if (typeof pObj.deadzone === 'number' && Number.isFinite(pObj.deadzone)) {
        profile.deadzone = Math.max(0, Math.min(0.45, pObj.deadzone));
      }
      if (pObj.bindings && typeof pObj.bindings === 'object') {
        const rawBindings = pObj.bindings as Record<string, unknown>;
        for (const control of Object.keys(DEFAULT_GAMEPAD_BINDINGS) as GamepadTargetControl[]) {
          if (!(control in rawBindings)) continue;
          const sanitized = sanitizeGamepadSource(rawBindings[control]);
          if (sanitized !== undefined) {
            profile.bindings[control] = sanitized;
          }
        }
      }
      base.gamepadProfiles[id] = profile;
    }
  }

  return base;
}

const listeners = new Set<(config: InputBindingsConfig) => void>();
let cachedConfig: InputBindingsConfig | null = null;

export function loadInputBindings(): InputBindingsConfig {
  if (cachedConfig) return cachedConfig;
  if (typeof localStorage === 'undefined') {
    cachedConfig = createDefaultInputBindings();
    return cachedConfig;
  }
  try {
    const raw = localStorage.getItem(INPUT_BINDINGS_STORAGE_KEY);
    if (raw) {
      cachedConfig = sanitizeInputBindingsConfig(JSON.parse(raw));
      return cachedConfig;
    }
  } catch {
    // Ignore storage read/parse errors and fall back to defaults.
  }
  cachedConfig = createDefaultInputBindings();
  return cachedConfig;
}

export function saveInputBindings(config: InputBindingsConfig): InputBindingsConfig {
  const sanitized = sanitizeInputBindingsConfig(config);
  cachedConfig = sanitized;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(INPUT_BINDINGS_STORAGE_KEY, JSON.stringify(sanitized));
    } catch {
      // Ignore storage quota/access failures.
    }
  }
  listeners.forEach((listener) => listener(sanitized));
  return sanitized;
}

export function resetInputBindingsCacheForTest(): void {
  cachedConfig = null;
}

export function subscribeInputBindings(listener: (config: InputBindingsConfig) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resolveGamepadProfile(
  config: InputBindingsConfig,
  padId?: string | null,
): GamepadMappingProfile {
  if (padId && config.gamepadProfiles[padId]) {
    return config.gamepadProfiles[padId];
  }
  return config.gamepadProfiles[GAMEPAD_DEFAULT_PROFILE_ID] ?? createDefaultGamepadProfile();
}

export function getBindingForTarget(
  profile: GamepadMappingProfile | null | undefined,
  target: GamepadTargetControl,
): GamepadSourceBinding | null {
  if (profile && target in profile.bindings) {
    const val = profile.bindings[target];
    return val === undefined ? DEFAULT_GAMEPAD_BINDINGS[target] : val;
  }
  return DEFAULT_GAMEPAD_BINDINGS[target];
}

export function evalGamepadAxisDeflection(
  rawValue: number,
  dir: 1 | -1,
  rest = 0,
  deadzone = 0,
): number {
  if (!Number.isFinite(rawValue)) return 0;
  const boundedRest = Math.max(-1, Math.min(1, rest));
  let mag: number;
  if (Math.abs(boundedRest) < 0.35) {
    mag = clamp01(dir > 0 ? rawValue : -rawValue);
  } else {
    const span = dir > 0 ? Math.max(0.25, 1 - boundedRest) : Math.max(0.25, boundedRest + 1);
    mag = clamp01(((rawValue - boundedRest) * dir) / span);
  }
  const dz = Math.max(0, Math.min(0.45, deadzone));
  if (dz <= 0) return mag;
  if (mag <= dz) return 0;
  return clamp01((mag - dz) / (1 - dz));
}

export function detectHatSector(rawValue: number): number | null {
  if (!Number.isFinite(rawValue) || rawValue < -1.08 || rawValue > 1.08) return null;
  const sector = Math.round(((rawValue + 1) * 7) / 2);
  return sector >= 0 && sector <= 7 ? sector : null;
}

export function evalHatDirection(rawValue: number, dir: GamepadHatDirection): boolean {
  const sector = detectHatSector(rawValue);
  if (sector === null) return false;
  switch (dir) {
    case 'up':
      return sector === 7 || sector === 0 || sector === 1;
    case 'right':
      return sector === 1 || sector === 2 || sector === 3;
    case 'down':
      return sector === 3 || sector === 4 || sector === 5;
    case 'left':
      return sector === 5 || sector === 6 || sector === 7;
  }
}

function hatSectorToDirection(
  sector: number,
  targetHint?: GamepadTargetControl,
): GamepadHatDirection {
  if (sector === 0) return 'up';
  if (sector === 2) return 'right';
  if (sector === 4) return 'down';
  if (sector === 6) return 'left';
  const candidates: readonly [GamepadHatDirection, GamepadHatDirection] =
    sector === 1
      ? ['up', 'right']
      : sector === 3
        ? ['down', 'right']
        : sector === 5
          ? ['down', 'left']
          : ['up', 'left'];
  if (targetHint === 'dpadDown' || targetHint === 'lyNeg' || targetHint === 'ryNeg') {
    if (candidates.includes('down')) return 'down';
  }
  if (targetHint === 'dpadUp' || targetHint === 'lyPos' || targetHint === 'ryPos') {
    if (candidates.includes('up')) return 'up';
  }
  if (targetHint === 'dpadLeft' || targetHint === 'lxNeg' || targetHint === 'rxNeg') {
    if (candidates.includes('left')) return 'left';
  }
  if (targetHint === 'dpadRight' || targetHint === 'lxPos' || targetHint === 'rxPos') {
    if (candidates.includes('right')) return 'right';
  }
  return candidates[0];
}

export function readGamepadSourceValue(
  pad: GamepadInputSourceLike,
  binding: GamepadSourceBinding | null,
  deadzone = 0,
  applyDeadzone = true,
): number {
  if (!binding) return 0;
  if (binding.kind === 'button') {
    const btn = pad.buttons[binding.index];
    if (!btn) return 0;
    if (Number.isFinite(btn.value)) return clamp01(btn.value);
    return btn.pressed ? 1 : 0;
  }
  const raw = pad.axes[binding.index];
  if (!Number.isFinite(raw)) return 0;
  if (binding.kind === 'hat') {
    return evalHatDirection(raw, binding.dir) ? 1 : 0;
  }
  return evalGamepadAxisDeflection(raw, binding.dir, binding.rest ?? 0, applyDeadzone ? deadzone : 0);
}

export function isGamepadSourcePressed(
  pad: GamepadInputSourceLike,
  binding: GamepadSourceBinding | null,
): boolean {
  if (!binding) return false;
  if (binding.kind === 'button') {
    const btn = pad.buttons[binding.index];
    return Boolean(btn && (btn.pressed || btn.value > 0.5));
  }
  if (binding.kind === 'hat') {
    const raw = pad.axes[binding.index];
    return Number.isFinite(raw) && evalHatDirection(raw, binding.dir);
  }
  return readGamepadSourceValue(pad, binding, 0, false) > 0.5;
}

export function detectGamepadCapture(
  baselineButtons: ReadonlyArray<number>,
  baselineAxes: ReadonlyArray<number>,
  pad: GamepadInputSourceLike,
  targetHint?: GamepadTargetControl,
): GamepadSourceBinding | null {
  let bestButtonIdx = -1;
  let bestButtonDelta = 0;
  for (let i = 0; i < pad.buttons.length; i += 1) {
    const btn = pad.buttons[i];
    if (!btn) continue;
    const base = baselineButtons[i] ?? 0;
    const val = btn.pressed ? Math.max(1, btn.value) : clamp01(btn.value);
    const delta = val - base;
    if (val >= 0.6 && base < 0.45 && delta > bestButtonDelta) {
      bestButtonDelta = delta;
      bestButtonIdx = i;
    }
  }
  if (bestButtonIdx >= 0) {
    return { kind: 'button', index: bestButtonIdx };
  }

  for (let i = 0; i < pad.axes.length; i += 1) {
    const val = pad.axes[i];
    if (!Number.isFinite(val)) continue;
    const base = baselineAxes[i] ?? 0;
    // DirectInput / HID POV HAT switches rest outside [-1.05, +1.05] (typically +1.2857 or +3.2857)
    if (Math.abs(base) > 1.08) {
      const sector = detectHatSector(val);
      if (sector !== null) {
        return { kind: 'hat', index: i, dir: hatSectorToDirection(sector, targetHint) };
      }
    }
  }

  let bestAxisIdx = -1;
  let bestAxisDelta = 0;
  let bestAxisVal = 0;
  let bestAxisBase = 0;
  for (let i = 0; i < pad.axes.length; i += 1) {
    const val = pad.axes[i];
    if (!Number.isFinite(val)) continue;
    const base = baselineAxes[i] ?? 0;
    if (Math.abs(base) > 1.08) continue;
    const delta = Math.abs(val - base);
    if (delta >= 0.42 && delta > bestAxisDelta) {
      bestAxisDelta = delta;
      bestAxisIdx = i;
      bestAxisVal = val;
      bestAxisBase = base;
    }
  }
  if (bestAxisIdx >= 0) {
    const rest =
      Math.abs(bestAxisBase) < 0.3
        ? 0
        : bestAxisBase <= -0.65
          ? -1
          : bestAxisBase >= 0.65
            ? 1
            : Number(bestAxisBase.toFixed(2));
    const dir: 1 | -1 = bestAxisVal >= bestAxisBase ? 1 : -1;
    return { kind: 'axis', index: bestAxisIdx, dir, rest };
  }
  return null;
}

export function matchesShortcut(
  event: { code?: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean },
  shortcut: ShortcutBinding | null | undefined,
): boolean {
  if (!shortcut || !shortcut.code) return false;
  return (
    event.code === shortcut.code &&
    Boolean(event.ctrlKey) === shortcut.ctrlKey &&
    Boolean(event.shiftKey) === shortcut.shiftKey &&
    Boolean(event.altKey) === shortcut.altKey
  );
}

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
]);

export function isModifierOnlyCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

export function deriveDomKeyFromCode(code: string, fallbackKey = ''): string {
  if (code.startsWith('Key') && code.length === 4) {
    return code.slice(3).toLowerCase();
  }
  if (code.startsWith('Digit') && code.length === 6) {
    return code.slice(5);
  }
  if (code.startsWith('Numpad') && code.length === 7 && /\d/.test(code[6])) {
    return code[6];
  }
  switch (code) {
    case 'Space':
      return ' ';
    case 'Enter':
    case 'NumpadEnter':
      return 'Enter';
    case 'Tab':
      return 'Tab';
    case 'Backspace':
      return 'Backspace';
    case 'Escape':
      return 'Escape';
    case 'ShiftLeft':
    case 'ShiftRight':
      return 'Shift';
    case 'ControlLeft':
    case 'ControlRight':
      return 'Control';
    case 'AltLeft':
    case 'AltRight':
      return 'Alt';
    case 'MetaLeft':
    case 'MetaRight':
    case 'OSLeft':
    case 'OSRight':
      return 'Meta';
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'Delete':
    case 'Insert':
    case 'Home':
    case 'End':
    case 'PageUp':
    case 'PageDown':
    case 'CapsLock':
    case 'ContextMenu':
      return code;
    default:
      if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
      return fallbackKey;
  }
}

export function resolveKeyRemapping(
  rules: ReadonlyArray<KeyRemapRule>,
  code: string,
  key: string,
  vk?: number,
): { code: string; key: string; vk?: number; remapped: boolean } {
  if (!code || rules.length === 0) {
    return { code, key, vk, remapped: false };
  }
  const match = rules.find((rule) => rule.fromCode === code);
  if (!match || !match.toCode || match.toCode === code) {
    return { code, key, vk, remapped: false };
  }
  return {
    code: match.toCode,
    key: deriveDomKeyFromCode(match.toCode, ''),
    vk: undefined,
    remapped: true,
  };
}

export function formatKeyCode(code: string): string {
  if (!code) return '—';
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (code.startsWith('Numpad') && code.length > 6) return `Num ${code.slice(6)}`;
  switch (code) {
    case 'Space':
      return 'Space';
    case 'Escape':
      return 'Esc';
    case 'Backspace':
      return 'Backspace';
    case 'CapsLock':
      return 'Caps Lock';
    case 'ShiftLeft':
      return 'L-Shift';
    case 'ShiftRight':
      return 'R-Shift';
    case 'ControlLeft':
      return 'L-Ctrl';
    case 'ControlRight':
      return 'R-Ctrl';
    case 'AltLeft':
      return 'L-Alt';
    case 'AltRight':
      return 'R-Alt';
    case 'MetaLeft':
    case 'OSLeft':
      return 'L-Win';
    case 'MetaRight':
    case 'OSRight':
      return 'R-Win';
    case 'ContextMenu':
      return 'Menu';
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    case 'Semicolon':
      return ';';
    case 'Equal':
      return '=';
    case 'Comma':
      return ',';
    case 'Minus':
      return '-';
    case 'Period':
      return '.';
    case 'Slash':
      return '/';
    case 'Backquote':
      return '`';
    case 'BracketLeft':
      return '[';
    case 'Backslash':
      return '\\';
    case 'BracketRight':
      return ']';
    case 'Quote':
      return "'";
    default:
      return code;
  }
}

export function formatShortcutCombo(shortcut: ShortcutBinding | null | undefined): string {
  if (!shortcut || !shortcut.code) return '';
  const parts: string[] = [];
  if (shortcut.ctrlKey) parts.push('Ctrl');
  if (shortcut.altKey) parts.push('Alt');
  if (shortcut.shiftKey) parts.push('Shift');
  parts.push(formatKeyCode(shortcut.code));
  return parts.join(' + ');
}
