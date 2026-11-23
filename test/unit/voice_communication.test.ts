import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
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
  let appliedPreferences = { ...DEFAULT_VOICE_PREFERENCES };
  const g = globalThis as Record<string, unknown>;
  g.__voicePopoverTestFixture = {
    roomState: {
      inVoice: true,
      voiceMicMuted: true,
      voiceDeafened: false,
      voiceInputLevelDb: -60,
      voiceThresholdDb: -50,
      isLocalSpeaking: false,
      voicePreferences: appliedPreferences,
    },
    applyVoicePreferences(next: typeof DEFAULT_VOICE_PREFERENCES) {
      appliedPreferences = { ...next };
      (g.__voicePopoverTestFixture as { roomState: { voicePreferences: typeof DEFAULT_VOICE_PREFERENCES } }).roomState.voicePreferences = appliedPreferences;
    },
    openSettings(tab?: string) {
      openedSettingsTab = tab ?? null;
    },
  };

  const mocks: Record<string, string> = {
    useRoom: 'export const useRoom = () => globalThis.__voicePopoverTestFixture.roomState;',
    room_service: `export const roomService = {
      get voicePreferences() { return globalThis.__voicePopoverTestFixture.roomState.voicePreferences; },
      applyVoicePreferences: (next) => { globalThis.__voicePopoverTestFixture.applyVoicePreferences(next); return Promise.resolve(); },
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

    // Open output quick-config dropdown from output chevron.
    await act(async () => {
      outputConfigBtn.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

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
