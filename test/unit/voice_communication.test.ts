import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import {
  clampSensitivityDb,
  clampVoiceVolume,
  computeNextVoiceMuteDeafen,
  DEFAULT_VOICE_PREFERENCES,
  getSavedUserVoiceVolume,
  loadVoicePreferences,
  normalizeVoicePreferences,
  saveUserVoiceVolume,
  saveVoicePreferences,
} from '../../src/core/voice_preferences.ts';
import {
  createDefaultInputBindings,
  DEFAULT_SHORTCUTS,
  loadInputBindings,
  resetInputBindingsCacheForTest,
  sanitizeInputBindingsConfig,
  saveInputBindings,
} from '../../src/core/input_bindings.ts';

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key: string) { return store.has(key) ? store.get(key)! : null; },
    key(index: number) { return Array.from(store.keys())[index] ?? null; },
    removeItem(key: string) { store.delete(key); },
    setItem(key: string, value: string) { store.set(key, String(value)); },
  };
}

test('voice preferences clamp input/output volumes to 0-200%, sensitivity to -100..0 dB, and persist round-trip', () => {
  const storage = createMemoryStorage();
  assert.equal(clampVoiceVolume(-20), 0);
  assert.equal(clampVoiceVolume(154.6), 155);
  assert.equal(clampVoiceVolume(350), 200);
  assert.equal(clampVoiceVolume(Number.NaN), 100);

  assert.equal(clampSensitivityDb(-140), -100);
  assert.equal(clampSensitivityDb(-42.4), -42);
  assert.equal(clampSensitivityDb(12), 0);
  assert.equal(clampSensitivityDb(Number.NaN), -50);

  const normalized = normalizeVoicePreferences({
    inputDeviceId: 'mic-usb-1',
    outputDeviceId: 'headset-2',
    inputVolume: 185,
    outputVolume: 240,
    noiseSuppressionMode: 'high',
    echoCancellation: false,
    autoGainControl: false,
    autoSensitivity: false,
    sensitivityDb: -38,
  });
  assert.deepEqual(normalized, {
    inputDeviceId: 'mic-usb-1',
    outputDeviceId: 'headset-2',
    inputVolume: 185,
    outputVolume: 200,
    noiseSuppressionMode: 'high',
    echoCancellation: false,
    autoGainControl: false,
    autoSensitivity: false,
    sensitivityDb: -38,
  });

  saveVoicePreferences(normalized, storage);
  assert.deepEqual(loadVoicePreferences(storage), normalized);
  assert.deepEqual(normalizeVoicePreferences({ noiseSuppressionMode: 'invalid' }), DEFAULT_VOICE_PREFERENCES);
});

test('per-user voice volumes persist permanently with publicKey priority and name fallback', () => {
  const storage = createMemoryStorage();

  // Save before publicKey is known (falls back to normalized username).
  saveUserVoiceVolume(undefined, '  Alice  ', 165, false, storage);
  assert.deepEqual(getSavedUserVoiceVolume(undefined, 'alice', storage), { volume: 165, muted: false });
  assert.deepEqual(getSavedUserVoiceVolume('pk-alice-1', 'Alice', storage), { volume: 165, muted: false });

  // Saving with publicKey migrates/stores under pk: and preserves across >250 users without eviction.
  saveUserVoiceVolume('pk-alice-1', 'Alice', 190, true, storage);
  for (let i = 0; i < 260; i += 1) {
    saveUserVoiceVolume(`pk-peer-${i}`, `User${i}`, (i % 200) + 1, false, storage);
  }
  assert.deepEqual(getSavedUserVoiceVolume('pk-alice-1', 'AliceRenamed', storage), { volume: 190, muted: true });
  assert.deepEqual(getSavedUserVoiceVolume(undefined, 'UnknownUser', storage), { volume: 100, muted: false });
});

test('deafen mutes active mic simultaneously, restores previous mic state on undeafen, and unmuting clears deafen', () => {
  // Active mic -> deafen -> undeafen restores active mic
  let state = { micMuted: false, deafened: false, micMutedBeforeDeafen: false };
  state = computeNextVoiceMuteDeafen(state, 'toggleDeafen');
  assert.deepEqual(state, { micMuted: true, deafened: true, micMutedBeforeDeafen: false });
  state = computeNextVoiceMuteDeafen(state, 'toggleDeafen');
  assert.deepEqual(state, { micMuted: false, deafened: false, micMutedBeforeDeafen: false });

  // Already muted mic -> deafen -> undeafen keeps mic muted
  state = { micMuted: true, deafened: false, micMutedBeforeDeafen: true };
  state = computeNextVoiceMuteDeafen(state, 'toggleDeafen');
  assert.deepEqual(state, { micMuted: true, deafened: true, micMutedBeforeDeafen: true });
  state = computeNextVoiceMuteDeafen(state, 'toggleDeafen');
  assert.deepEqual(state, { micMuted: true, deafened: false, micMutedBeforeDeafen: true });

  // Unmuting mic while deafened clears deafen automatically
  state = { micMuted: true, deafened: true, micMutedBeforeDeafen: false };
  state = computeNextVoiceMuteDeafen(state, 'toggleMute');
  assert.deepEqual(state, { micMuted: false, deafened: false, micMutedBeforeDeafen: false });
});

test('ContextMenu slider updates live 0-200% value without dismissing and supports double-click reset and Escape', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
  const prevGlobals: Record<string, unknown> = {};
  const keys = ['window', 'document', 'HTMLElement', 'Element', 'MutationObserver', 'HTMLInputElement', 'HTMLTextAreaElement', 'Node', 'DOMParser'];
  for (const key of keys) {
    prevGlobals[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = dom.window[key];
  }
  const prevAct = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (dom.window as unknown as { matchMedia: () => { matches: boolean } }).matchMedia = () => ({ matches: false });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', { get() { return this.getAttribute('role') === 'menu' ? 220 : 0; }, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', { get() { return this.getAttribute('role') === 'menu' ? 140 : 0; }, configurable: true });

  const require = createRequire(import.meta.url);
  const bundle = await build({
    stdin: { contents: "export * from './src/components/common/ContextMenu.tsx';", resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    plugins: [{
      name: 'shared-react',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
      },
    }],
  });
  const { ContextMenuProvider, useContextMenu } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);

  let observedVolume = 100;
  let muteToggled = 0;

  function Harness() {
    const open = useContextMenu();
    return React.createElement('button', {
      id: 'card-trigger',
      onContextMenu: (event: React.MouseEvent) => open(event, [
        {
          id: 'voice-vol',
          label: 'Volume da voz',
          slider: {
            value: observedVolume,
            min: 0,
            max: 200,
            step: 1,
            defaultValue: 100,
            onChange: (next: number) => { observedVolume = next; },
          },
        },
        {
          id: 'voice-mute',
          label: 'Silenciar usuário',
          onSelect: () => { muteToggled += 1; },
        },
      ]),
    }, 'User Card');
  }

  try {
    await act(async () => root.render(React.createElement(ContextMenuProvider, null, React.createElement(Harness))));
    const trigger = document.getElementById('card-trigger')!;
    await act(async () => trigger.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 80, button: 2 })));

    const slider = document.querySelector<HTMLInputElement>('.context-menu-slider-input');
    assert.ok(slider, 'slider input should render inside context menu');
    assert.equal(slider.min, '0');
    assert.equal(slider.max, '200');
    assert.equal(slider.value, '100');

    // Simulate dragging to 175%: menu stays open and readout updates.
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(slider, '175');
      slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      slider.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.equal(observedVolume, 175);
    assert.equal(document.querySelector('.context-menu-slider-value')?.textContent, '175%');
    assert.ok(document.querySelector('[role="menu"]'), 'menu must stay open while adjusting slider');

    // Double-click resets slider to 100%.
    await act(async () => {
      slider.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
    });
    assert.equal(observedVolume, 100);
    assert.equal(document.querySelector('.context-menu-slider-value')?.textContent, '100%');

    // Escape closes menu and restores focus to trigger.
    await act(async () => {
      document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    assert.equal(document.activeElement, trigger);
    assert.equal(muteToggled, 0);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of keys) {
      if (prevGlobals[key] === undefined) delete (globalThis as Record<string, unknown>)[key];
      else (globalThis as Record<string, unknown>)[key] = prevGlobals[key];
    }
    if (prevAct === undefined) delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
    else (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = prevAct;
  }
});

test('VoiceControlsBar opens input and output VoiceQuickPopover cleanly without render loop and closes on Escape', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
  const prevGlobals: Record<string, unknown> = {};
  const keys = [
    'window',
    'document',
    'HTMLElement',
    'Element',
    'MutationObserver',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'Node',
    'DOMParser',
    'CustomEvent',
    'localStorage',
    'getComputedStyle',
    'ResizeObserver',
  ];
  for (const key of keys) {
    prevGlobals[key] = (globalThis as Record<string, unknown>)[key];
    if (key === 'getComputedStyle') {
      (globalThis as Record<string, unknown>)[key] = dom.window.getComputedStyle.bind(dom.window);
    } else if (key === 'ResizeObserver') {
      (globalThis as Record<string, unknown>)[key] = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    } else {
      (globalThis as Record<string, unknown>)[key] = dom.window[key];
    }
  }
  const prevAct = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (dom.window as unknown as { matchMedia: () => { matches: boolean } }).matchMedia = () => ({ matches: false });

  const nav = globalThis.navigator as unknown as { mediaDevices?: unknown };
  const prevMediaDevices = nav.mediaDevices;
  nav.mediaDevices = {
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Studio Mic' },
      { kind: 'audiooutput', deviceId: 'spk-1', label: 'Studio Headphones' },
    ],
    addEventListener() {},
    removeEventListener() {},
  };

  let openedSettingsTab: string | null = null;
  let micTestStarts = 0;
  let micTestStops = 0;
  let appliedPreferences = { ...DEFAULT_VOICE_PREFERENCES };
  const roomListeners = new Set<() => void>();
  const g = globalThis as Record<string, unknown>;
  let fixtureState = {
    inVoice: true,
    voiceMicMuted: true,
    voiceDeafened: false,
    voiceInputLevelDb: -100,
    voiceThresholdDb: -50,
    voiceMicTestActive: false,
    voiceTestGateOpen: false,
    isLocalSpeaking: false,
    voicePreferences: appliedPreferences,
  };
  g.__voicePopoverTestFixture = {
    listeners: roomListeners,
    get roomState() {
      return fixtureState;
    },
    applyVoicePreferences(next: typeof DEFAULT_VOICE_PREFERENCES) {
      appliedPreferences = { ...next };
      fixtureState = { ...fixtureState, voicePreferences: appliedPreferences };
      roomListeners.forEach((fn) => fn());
    },
    startVoiceMicTest() {
      micTestStarts += 1;
      fixtureState = {
        ...fixtureState,
        voiceMicTestActive: true,
        voiceInputLevelDb: -28,
        voiceTestGateOpen: true,
      };
      roomListeners.forEach((fn) => fn());
    },
    stopVoiceMicTest() {
      if (!fixtureState.voiceMicTestActive) return;
      micTestStops += 1;
      fixtureState = {
        ...fixtureState,
        voiceMicTestActive: false,
        voiceInputLevelDb: -100,
        voiceTestGateOpen: false,
      };
      roomListeners.forEach((fn) => fn());
    },
    openSettings(tab?: string) {
      openedSettingsTab = tab ?? null;
    },
  };

  const mocks: Record<string, string> = {
    useRoom: `import { useSyncExternalStore } from 'react';
      export const useRoom = () => useSyncExternalStore(
        (fn) => { globalThis.__voicePopoverTestFixture.listeners.add(fn); return () => globalThis.__voicePopoverTestFixture.listeners.delete(fn); },
        () => globalThis.__voicePopoverTestFixture.roomState,
      );`,
    room_service: `export const roomService = {
      get voicePreferences() { return globalThis.__voicePopoverTestFixture.roomState.voicePreferences; },
      applyVoicePreferences: (next) => { globalThis.__voicePopoverTestFixture.applyVoicePreferences(next); return Promise.resolve(); },
      startVoiceMicTest: () => { globalThis.__voicePopoverTestFixture.startVoiceMicTest(); return Promise.resolve(); },
      stopVoiceMicTest: () => { globalThis.__voicePopoverTestFixture.stopVoiceMicTest(); },
      toggleVoiceMute: () => Promise.resolve(),
      toggleVoiceDeafen: () => {},
    };`,
    useModal: `export const modalManager = {
      openSettings: (tab) => globalThis.__voicePopoverTestFixture.openSettings(tab),
    };`,
  };

  const require = createRequire(import.meta.url);
  const bundle = await build({
    stdin: { contents: "export { VoiceControlsBar } from './src/components/room/VoiceControlsBar.tsx';", resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    plugins: [{
      name: 'voice-popover-fixtures',
      setup(b) {
        b.onResolve({ filter: /\/(useRoom|room_service|useModal)$/ }, (args) => ({
          namespace: 'fixture',
          path: args.path.split('/').at(-1)!,
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: mocks[args.path],
          loader: 'js',
        }));
        b.onResolve({ filter: /^[^./]/ }, (args) => ({
          path: pathToFileURL(require.resolve(args.path)).href,
          external: true,
        }));
      },
    }],
  });

  const { VoiceControlsBar } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);

  try {
    await act(async () => {
      root.render(React.createElement(VoiceControlsBar));
    });

    const inputConfigBtn = document.getElementById('btn-voice-input-config') as HTMLButtonElement | null;
    const outputConfigBtn = document.getElementById('btn-voice-output-config') as HTMLButtonElement | null;
    assert.ok(inputConfigBtn && outputConfigBtn, 'chevron buttons should render');

    // Open input quick-config dropdown; must not throw Maximum update depth exceeded.
    await act(async () => {
      inputConfigBtn.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    const inputPopover = document.querySelector<HTMLElement>('.voice-quick-popover');
    assert.ok(inputPopover, 'input quick popover should mount inside document.body');
    assert.equal(inputPopover.style.visibility, 'visible', 'popover should become visible after positioning');
    assert.ok(document.getElementById('voice-quick-input-device'), 'input device select should render');
    assert.ok(document.getElementById('voice-quick-input-volume'), 'input volume slider should render');
    assert.ok(document.getElementById('voice-quick-noise-suppression'), 'noise suppression select should render');
    assert.ok(document.getElementById('voice-quick-auto-sensitivity'), 'auto sensitivity switch should render');
    assert.ok(document.querySelector('.voice-quick-settings-btn'), 'open communication settings button should render');

    // Quick mic test uses the inline meter bar as live preview even when mic is muted.
    const quickMicTestBtn = document.getElementById('btn-voice-quick-mic-test') as HTMLButtonElement | null;
    assert.ok(quickMicTestBtn, 'quick mic test button should render inside input popover');
    await act(async () => {
      quickMicTestBtn.click();
    });
    assert.equal(micTestStarts, 1);
    const meterFill = inputPopover.querySelector<HTMLElement>('.voice-meter-fill');
    assert.ok(meterFill?.classList.contains('is-active'), 'preview meter should show active state during test');
    assert.equal(meterFill?.style.width, '72%', 'preview meter width should reflect live dB level during test');

    // Switching to output quick-config stops the active quick mic test automatically.
    await act(async () => {
      outputConfigBtn.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    assert.equal(micTestStops, 1);

    const outputPopover = document.querySelector<HTMLElement>('.voice-quick-popover');
    assert.ok(outputPopover, 'output quick popover should remain mounted cleanly');
    assert.equal(outputPopover.style.visibility, 'visible');
    assert.ok(document.getElementById('voice-quick-output-device'), 'output device select should render');
    assert.ok(document.getElementById('voice-quick-output-volume'), 'output volume slider should render');

    // Pressing Escape dismisses the popover cleanly and restores focus to anchor.
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    assert.ok(
      !document.querySelector('.voice-quick-popover') ||
        document.querySelector('.voice-quick-popover')?.classList.contains('dropdown-closing'),
      'Escape should dismiss the quick popover',
    );
    assert.equal(openedSettingsTab, null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    delete g.__voicePopoverTestFixture;
    if (prevMediaDevices === undefined) delete nav.mediaDevices;
    else nav.mediaDevices = prevMediaDevices;
    for (const key of keys) {
      if (prevGlobals[key] === undefined) delete (globalThis as Record<string, unknown>)[key];
      else (globalThis as Record<string, unknown>)[key] = prevGlobals[key];
    }
    if (prevAct === undefined) delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
    else (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = prevAct;
  }
});

test('voice shortcuts default to unassigned, bind in Shortcuts & Keyboard settings, and execute when not paused', async () => {
  assert.equal(DEFAULT_SHORTCUTS.toggleVoiceMute, null);
  assert.equal(DEFAULT_SHORTCUTS.toggleVoiceDeafen, null);

  const defaults = createDefaultInputBindings();
  assert.equal(defaults.shortcuts.toggleVoiceMute, null);
  assert.equal(defaults.shortcuts.toggleVoiceDeafen, null);

  const sanitized = sanitizeInputBindingsConfig({
    shortcuts: {
      toggleVoiceMute: { code: 'KeyM', ctrlKey: true, shiftKey: true, altKey: false },
      toggleVoiceDeafen: { code: 'F9', ctrlKey: false, shiftKey: false, altKey: false },
    },
  });
  assert.deepEqual(sanitized.shortcuts.toggleVoiceMute, {
    code: 'KeyM',
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
  });
  assert.deepEqual(sanitized.shortcuts.toggleVoiceDeafen, {
    code: 'F9',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  });

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
  const prevGlobals: Record<string, unknown> = {};
  const keys = [
    'window',
    'document',
    'HTMLElement',
    'Element',
    'MutationObserver',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'Node',
    'DOMParser',
    'CustomEvent',
    'localStorage',
    'getComputedStyle',
  ];
  for (const key of keys) {
    prevGlobals[key] = (globalThis as Record<string, unknown>)[key];
    if (key === 'getComputedStyle') {
      (globalThis as Record<string, unknown>)[key] = dom.window.getComputedStyle.bind(dom.window);
    } else {
      (globalThis as Record<string, unknown>)[key] = dom.window[key];
    }
  }
  const prevAct = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (dom.window as unknown as { matchMedia: () => { matches: boolean } }).matchMedia = () => ({ matches: false });
  resetInputBindingsCacheForTest();

  let muteToggles = 0;
  let deafenToggles = 0;
  const g = globalThis as Record<string, unknown>;
  g.__voiceShortcutTestCounts = {
    toggleVoiceMute: () => { muteToggles += 1; },
    toggleVoiceDeafen: () => { deafenToggles += 1; },
  };

  const mocks: Record<string, string> = {
    core: 'export const isTauri = () => false; export const invoke = async () => {};',
    event: 'export const listen = async () => () => {};',
    room_service: `export const roomService = {
      toggleVoiceMute: () => { globalThis.__voiceShortcutTestCounts.toggleVoiceMute(); return Promise.resolve(); },
      toggleVoiceDeafen: () => { globalThis.__voiceShortcutTestCounts.toggleVoiceDeafen(); },
    };`,
  };

  const require = createRequire(import.meta.url);
  const bundle = await build({
    stdin: {
      contents: `
        export * from './src/services/voice_shortcuts.ts';
        export { KeybindingsSettingsPane } from './src/components/modals/KeybindingsSettingsPane.tsx';
        export * from './src/core/input_bindings.ts';
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    plugins: [{
      name: 'voice-shortcuts-fixtures',
      setup(b) {
        b.onResolve({ filter: /^@tauri-apps\/api\/(core|event)$/ }, (args) => ({
          namespace: 'fixture',
          path: args.path.split('/').at(-1)!,
        }));
        b.onResolve({ filter: /\/room_service(\.ts)?$/ }, () => ({
          namespace: 'fixture',
          path: 'room_service',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: mocks[args.path],
          loader: 'js',
        }));
        b.onResolve({ filter: /^[^./]/ }, (args) => ({
          path: pathToFileURL(require.resolve(args.path)).href,
          external: true,
        }));
      },
    }],
  });

  const bundled = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);

  let stopShortcuts: (() => void) | null = null;
  let latestConfig = bundled.createDefaultInputBindings();
  try {
    bundled.resetInputBindingsCacheForTest();
    stopShortcuts = bundled.startVoiceShortcuts();

    function Harness() {
      const [cfg, setCfg] = React.useState(bundled.createDefaultInputBindings);
      const [subTab, setSubTab] = React.useState<'keyboard' | 'gamepad'>('keyboard');
      latestConfig = cfg;
      return React.createElement(bundled.KeybindingsSettingsPane, {
        value: cfg,
        onChange: (next: typeof cfg) => {
          latestConfig = next;
          setCfg(next);
          bundled.saveInputBindings(next);
        },
        subTab,
        onSubTabChange: setSubTab,
      });
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });

    const muteCaptureBtn = document.getElementById('btn-shortcut-toggleVoiceMute') as HTMLButtonElement | null;
    const deafenCaptureBtn = document.getElementById('btn-shortcut-toggleVoiceDeafen') as HTMLButtonElement | null;
    assert.ok(muteCaptureBtn && deafenCaptureBtn, 'voice shortcut rows must appear in Shortcuts & Keyboard settings');

    // Hold Ctrl + Shift first: live modifier preview shows "Ctrl + Shift + ...".
    await act(async () => {
      muteCaptureBtn.click();
    });
    await act(async () => {
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        code: 'ControlLeft',
        ctrlKey: true,
        bubbles: true,
      }));
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        code: 'ShiftLeft',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }));
    });
    assert.equal(muteCaptureBtn.textContent, 'Ctrl + Shift + ...');

    // Bind Ctrl+Space first, then verify subsequent click/keyup bounce does not reopen capture.
    await act(async () => {
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        code: 'Space',
        ctrlKey: true,
        bubbles: true,
      }));
      muteCaptureBtn.click();
    });
    assert.deepEqual(latestConfig.shortcuts.toggleVoiceMute, {
      code: 'Space',
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
    });
    assert.equal(muteCaptureBtn.classList.contains('is-listening'), false);

    // Re-enter capture after click suppression settles and bind Ctrl+Shift+M cleanly.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      muteCaptureBtn.click();
    });
    await act(async () => {
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        code: 'KeyM',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }));
    });
    assert.deepEqual(latestConfig.shortcuts.toggleVoiceMute, {
      code: 'KeyM',
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
    });
    assert.equal(muteToggles, 0, 'binding the shortcut must not trigger toggle during capture');

    // Bind F9 to deafen toggle.
    await act(async () => {
      deafenCaptureBtn.click();
    });
    await act(async () => {
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'F9', bubbles: true }));
    });
    assert.deepEqual(latestConfig.shortcuts.toggleVoiceDeafen, {
      code: 'F9',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    });

    // Pressing bound keys triggers actions once per press (ignoring auto-repeat).
    await act(async () => {
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        code: 'KeyM',
        ctrlKey: true,
        shiftKey: true,
        repeat: false,
        bubbles: true,
      }));
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        code: 'KeyM',
        ctrlKey: true,
        shiftKey: true,
        repeat: true,
        bubbles: true,
      }));
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        code: 'F9',
        repeat: false,
        bubbles: true,
      }));
    });
    assert.equal(muteToggles, 1);
    assert.equal(deafenToggles, 1);
    assert.deepEqual(loadInputBindings().shortcuts.toggleVoiceMute, {
      code: 'KeyM',
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
    });

    // Clear mute shortcut back to unassigned via the row clear button.
    const clearMuteBtn = muteCaptureBtn.parentElement?.querySelector<HTMLButtonElement>('.btn-stream-pin');
    assert.ok(clearMuteBtn, 'clear button should render when shortcut is assigned');
    await act(async () => {
      clearMuteBtn.click();
    });
    assert.equal(latestConfig.shortcuts.toggleVoiceMute, null);
    bundled.saveInputBindings(bundled.createDefaultInputBindings());
    saveInputBindings(createDefaultInputBindings());
  } finally {
    stopShortcuts?.();
    await act(async () => root.unmount());
    dom.window.close();
    delete g.__voiceShortcutTestCounts;
    for (const key of keys) {
      if (prevGlobals[key] === undefined) delete (globalThis as Record<string, unknown>)[key];
      else (globalThis as Record<string, unknown>)[key] = prevGlobals[key];
    }
    if (prevAct === undefined) delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
    else (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = prevAct;
    resetInputBindingsCacheForTest();
  }
});

test('VoiceNoiseGateProcessor normalizes quiet microphones cleanly without clipping up to 200% input gain', () => {
  type ProcessorInstance = {
    port: { onmessage: ((ev: { data: Record<string, unknown> }) => void) | null };
    process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
  };
  let RegisteredClass: (new () => ProcessorInstance) | null = null;
  const sandbox = {
    sampleRate: 48000,
    Float32Array,
    Uint16Array,
    Math,
    AudioWorkletProcessor: class {
      port = { onmessage: null, postMessage() {} };
    },
    registerProcessor: (_name: string, cls: new () => ProcessorInstance) => {
      RegisteredClass = cls;
    },
  };
  vm.runInNewContext(fs.readFileSync('public/audio/voice-processor.worklet.js', 'utf8'), sandbox);
  assert.ok(RegisteredClass, 'worklet processor should register');

  const runSignal = (amp: number, inputGain: number) => {
    const proc = new RegisteredClass!();
    proc.port.onmessage?.({
      data: { noiseSuppressionMode: 'standard', autoSensitivity: false, sensitivityDb: -90, muted: false, inputGain },
    });
    for (let b = 0; b < 30; b += 1) {
      const inp = new Float32Array(128).map((_, i) => 0.001 * Math.sin(i));
      proc.process([[inp]], [[new Float32Array(128)]]);
    }
    let inSq = 0;
    let outSq = 0;
    let peak = 0;
    let samples = 0;
    for (let b = 0; b < 180; b += 1) {
      const inp = new Float32Array(128).map((_, i) => amp * Math.sin((b * 128 + i) * 0.08));
      const out = new Float32Array(128);
      proc.process([[inp]], [[out]]);
      if (b >= 90) {
        for (let i = 0; i < 128; i += 1) {
          inSq += inp[i] * inp[i];
          outSq += out[i] * out[i];
          peak = Math.max(peak, Math.abs(out[i]));
          samples += 1;
        }
      }
    }
    const inRms = Math.sqrt(inSq / samples);
    const outRms = Math.sqrt(outSq / samples);
    return { inRms, outRms, peak, outDb: 20 * Math.log10(outRms) };
  };

  // Quiet -33.5 dBFS mic at 100% input gain is boosted smoothly into conversational ~ -20 dBFS range.
  const quiet = runSignal(0.03, 1.0);
  assert.ok(quiet.outRms / quiet.inRms >= 2.5, `expected clear speech boost, got ${(quiet.outRms / quiet.inRms).toFixed(2)}x`);
  assert.ok(quiet.outDb >= -24 && quiet.outDb <= -16, `expected normalized speech dBFS, got ${quiet.outDb.toFixed(1)}`);

  // Loud hot mic stays controlled and 200% gain triggers clean linear limiting without clipping.
  const hot = runSignal(0.35, 1.0);
  assert.ok(hot.peak <= 0.88, `hot mic should settle cleanly below ceiling, got peak ${hot.peak.toFixed(3)}`);

  const boosted = runSignal(0.08, 2.0);
  assert.ok(boosted.outRms > quiet.outRms, '200% input gain should increase output loudness');
  assert.ok(boosted.peak <= 0.90, `peak limiter must prevent clipping, got peak ${boosted.peak.toFixed(3)}`);

  // High suppression rejects steady fan noise and short mouse clicks while opening cleanly for speech.
  const highProc = new RegisteredClass!();
  highProc.port.onmessage?.({
    data: { noiseSuppressionMode: 'high', autoSensitivity: true, sensitivityDb: -50, muted: false, inputGain: 1.0 },
  });
  let prng = 1234567;
  const nextRand = () => {
    prng = (prng * 1664525 + 1013904223) >>> 0;
    return (prng / 0x100000000) * 2 - 1;
  };
  const makeFanBlock = (blockIndex: number) =>
    new Float32Array(128).map((_, i) => {
      const t = (blockIndex * 128 + i) / 48000;
      return 0.028 * Math.sin(2 * Math.PI * 105 * t) + 0.022 * nextRand();
    });

  // 1) Steady fan noise for ~1.5s settles cleanly with gate closed.
  let fanOutSq = 0;
  let fanSamples = 0;
  for (let b = 0; b < 560; b += 1) {
    const out = new Float32Array(128);
    highProc.process([[makeFanBlock(b)]], [[out]]);
    if (b >= 500) {
      for (let i = 0; i < 128; i += 1) {
        fanOutSq += out[i] * out[i];
        fanSamples += 1;
      }
    }
  }
  const fanOutRms = Math.sqrt(fanOutSq / fanSamples);
  assert.ok(fanOutRms < 0.003, `steady fan noise should be suppressed on high mode, got RMS ${fanOutRms.toFixed(5)}`);

  // 2) Short high-frequency mouse click (2 blocks = 5.3 ms) must not open the gate.
  let clickOutSq = 0;
  let clickSamples = 0;
  for (let b = 560; b < 590; b += 1) {
    const inp = makeFanBlock(b);
    if (b === 562 || b === 563) {
      for (let i = 0; i < 128; i += 1) {
        const t = (b * 128 + i) / 48000;
        inp[i] += 0.18 * Math.sin(2 * Math.PI * 6200 * t) + 0.12 * nextRand();
      }
    }
    const out = new Float32Array(128);
    highProc.process([[inp]], [[out]]);
    for (let i = 0; i < 128; i += 1) {
      clickOutSq += out[i] * out[i];
      clickSamples += 1;
    }
  }
  const clickOutRms = Math.sqrt(clickOutSq / clickSamples);
  assert.ok(clickOutRms < 0.005, `short mouse click should be rejected on high mode, got RMS ${clickOutRms.toFixed(5)}`);

  // 3) Sustained voice formants over the same fan noise open the gate and pass through clearly.
  let speechOutSq = 0;
  let speechSamples = 0;
  for (let b = 590; b < 680; b += 1) {
    const inp = makeFanBlock(b);
    for (let i = 0; i < 128; i += 1) {
      const t = (b * 128 + i) / 48000;
      inp[i] += 0.055 * Math.sin(2 * Math.PI * 380 * t)
        + 0.045 * Math.sin(2 * Math.PI * 920 * t)
        + 0.025 * Math.sin(2 * Math.PI * 1850 * t);
    }
    const out = new Float32Array(128);
    highProc.process([[inp]], [[out]]);
    if (b >= 620) {
      for (let i = 0; i < 128; i += 1) {
        speechOutSq += out[i] * out[i];
        speechSamples += 1;
      }
    }
  }
  const speechOutRms = Math.sqrt(speechOutSq / speechSamples);
  assert.ok(speechOutRms > 0.05, `voice formants over fan noise must pass clearly, got RMS ${speechOutRms.toFixed(4)}`);
});
