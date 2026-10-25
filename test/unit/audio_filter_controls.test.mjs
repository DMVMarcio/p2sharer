import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

test('audio filtering defaults, draft switching, mute-all and native apply use the real hook', async () => {
  const require = createRequire(import.meta.url);
  const bundle = await build({
    stdin: { contents: "export { useAudioFilter } from './src/hooks/useAudioFilter'; export { stateStore } from './src/core/state_store';",
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
    plugins: [{ name: 'fixtures', setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'invoke', namespace: 'fixture' }));
      builder.onResolve({ filter: /useToast$/ }, () => ({ path: 'toast', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'invoke'
        ? 'export const invoke = (...args) => globalThis.audioFilterInvoke(...args);'
        : 'export const showToast = () => {};', loader: 'js' }));
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test' });
  const keys = ['window', 'document', 'navigator', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT', 'audioFilterInvoke'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys.slice(0, 4)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const calls = [];
  globalThis.audioFilterInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === 'list_audio_processes') return [
      { pid: 3, name: 'Game.exe' }, { pid: 1, name: 'Discord.exe' }, { pid: 2, name: 'P2Sharer.exe' },
    ];
  };
  const { useAudioFilter, stateStore } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  let filter;
  const Harness = () => { filter = useAudioFilter(); return null; };
  let revision = 0;
  const mount = () => act(async () => root.render(React.createElement(Harness, { key: ++revision })));
  try {
    assert.ok(stateStore.excludeProcessNames.has('discord'));
    assert.ok(stateStore.excludeProcessNames.has('p2sharer'));
    localStorage.setItem('p2sharer_audio_exclude_names', '[]');
    stateStore.loadFromStorage();
    assert.equal(stateStore.excludeProcessNames.size, 0, 'saved empty exclusions remain intentional');
    localStorage.removeItem('p2sharer_audio_exclude_names');
    stateStore.loadFromStorage();
    await mount();
    await act(async () => filter.loadProcesses());
    assert.deepEqual([...filter.selectedPids], [1, 2]);
    assert.equal(filter.selectedNames.size, 2, 'executable aliases share one selection');
    const openingOrder = filter.processes.map(process => process.name);
    assert.deepEqual(openingOrder, ['Discord.exe', 'P2Sharer.exe', 'Game.exe']);
    await act(async () => filter.toggleProcess(filter.processes[0], false));
    assert.deepEqual(filter.processes.map(process => process.name), openingOrder);
    await act(async () => filter.loadProcesses());
    assert.deepEqual(filter.processes.map(process => process.name), openingOrder, 'refresh keeps the opening order');
    await act(async () => filter.toggleProcess(filter.processes[0], true));
    await act(async () => filter.setSearchText('Discord.exe'));
    assert.equal(filter.processes.length, 1);
    await act(async () => filter.setSearchText(''));
    await act(async () => filter.setCaptureChoice('include'));
    await act(async () => filter.toggleProcess(filter.processes.find(process => process.name === 'Game.exe'), true));
    await act(async () => filter.setCaptureChoice('none'));
    assert.equal(filter.captureChoice, 'none');
    assert.equal(stateStore.selectedFilterMode, 'exclude', 'draft changes do not commit');
    await act(async () => filter.setCaptureChoice('include'));
    assert.ok(filter.selectedNames.has('game'), 'switching away from mute-all retains the draft');
    await mount();
    assert.equal(filter.captureChoice, 'exclude', 'closing without Apply discards the draft');
    await act(async () => filter.setCaptureChoice('include'));
    assert.equal(filter.selectedNames.size, 0);
    await act(async () => filter.toggleProcess({ pid: 3, name: 'Game.exe' }, true));
    stateStore.isSharingScreen = true;
    await act(async () => filter.setCaptureChoice('none'));
    await act(async () => { assert.equal(await filter.applyFilters(), true); });
    assert.equal(stateStore.selectedFilterMode, 'include');
    assert.equal(stateStore.includeProcessNames.size, 0);
    assert.deepEqual(calls.at(-1).args.config, { mode: 'include', target_pids: [], target_names: [], sample_rate: 48000 });
    await mount();
    assert.equal(filter.captureChoice, 'none', 'saved mute-all reopens as an explicit choice');
    await act(async () => filter.setCaptureChoice('full'));
    await act(async () => filter.applyFilters());
    assert.equal(calls.at(-1).args.config.mode, 'full');
    await act(async () => filter.loadProcesses());
    await act(async () => filter.setCaptureChoice('include'));
    await act(async () => filter.toggleProcess(filter.processes.find(process => process.name === 'Game.exe'), true));
    await act(async () => filter.applyFilters());
    assert.deepEqual(calls.at(-1).args.config, { mode: 'include', target_pids: [3], target_names: ['game'], sample_rate: 48000 });
    await act(async () => filter.setCaptureChoice('exclude'));
    await act(async () => filter.toggleProcess(filter.processes.find(process => process.name === 'Discord.exe'), false));
    await act(async () => filter.applyFilters());
    assert.deepEqual(calls.at(-1).args.config, { mode: 'exclude', target_pids: [2], target_names: ['p2sharer'], sample_rate: 48000 });
    await act(async () => root.unmount());
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

test('sub-process accordion toggling supports granular and parent all-or-nothing exclusion', async () => {
  const require = createRequire(import.meta.url);
  const bundle = await build({
    stdin: { contents: "export { useAudioFilter } from './src/hooks/useAudioFilter'; export { stateStore } from './src/core/state_store';",
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
    plugins: [{ name: 'fixtures', setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'invoke', namespace: 'fixture' }));
      builder.onResolve({ filter: /useToast$/ }, () => ({ path: 'toast', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'invoke'
        ? 'export const invoke = (...args) => globalThis.audioFilterInvoke(...args);'
        : 'export const showToast = () => {};', loader: 'js' }));
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test' });
  const keys = ['window', 'document', 'navigator', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT', 'audioFilterInvoke'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys.slice(0, 4)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const calls = [];
  globalThis.audioFilterInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === 'list_audio_processes') return [
      {
        pid: 100,
        name: 'Discord.exe',
        window_title: 'Discord - #general',
        sub_processes: [
          { pid: 100, window_title: 'Discord - #general', has_audio: false },
          { pid: 101, window_title: null, has_audio: true },
          { pid: 102, window_title: null, has_audio: false },
        ],
      },
      {
        pid: 200,
        name: 'P2Sharer.exe',
        window_title: 'P2Sharer',
        sub_processes: [{ pid: 200, window_title: 'P2Sharer', has_audio: false }],
      },
    ];
  };
  const { useAudioFilter, stateStore } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  let filter;
  const Harness = () => { filter = useAudioFilter(); return null; };
  let revision = 0;
  const mount = () => act(async () => root.render(React.createElement(Harness, { key: ++revision })));

  try {
    localStorage.removeItem('p2sharer_audio_exclude_names');
    stateStore.loadFromStorage();
    await mount();
    await act(async () => filter.loadProcesses());

    const discord = filter.processes.find(p => p.name === 'Discord.exe');
    assert.ok(discord);
    assert.equal(filter.getProcessSelectionState(discord), 'all');
    assert.deepEqual([...filter.selectedPids].sort((a, b) => a - b), [100, 101, 102, 200]);

    // Uncheck only sub-process 101
    await act(async () => filter.toggleSubProcess(discord, 101, false));
    assert.equal(filter.getProcessSelectionState(discord), 'partial');
    assert.equal(filter.selectedNames.has('discord'), false, 'Partial selection removes whole app name');
    assert.deepEqual([...filter.selectedPids].sort((a, b) => a - b), [100, 102, 200]);

    // Apply with partial exclusion
    stateStore.isSharingScreen = true;
    await act(async () => filter.applyFilters());
    const lastConfig = calls.at(-1).args.config;
    assert.equal(lastConfig.mode, 'exclude');
    assert.ok(!lastConfig.target_names.includes('discord'), 'Partial exclusion must not include app name in target_names');
    assert.ok(lastConfig.target_names.includes('p2sharer'));
    assert.deepEqual(lastConfig.target_pids.sort((a, b) => a - b), [100, 102, 200]);

    // Toggle parent off -> unselects all discord pids
    await act(async () => filter.toggleProcess(discord, false));
    assert.equal(filter.getProcessSelectionState(discord), 'none');
    assert.deepEqual([...filter.selectedPids], [200]);

    // Toggle parent on -> selects all discord pids and re-adds name
    await act(async () => filter.toggleProcess(discord, true));
    assert.equal(filter.getProcessSelectionState(discord), 'all');
    assert.equal(filter.selectedNames.has('discord'), true);
    assert.deepEqual([...filter.selectedPids].sort((a, b) => a - b), [100, 101, 102, 200]);

    // Search by subprocess PID
    await act(async () => filter.setSearchText('101'));
    assert.equal(filter.processes.length, 1);
    assert.equal(filter.processes[0].name, 'Discord.exe');

    await act(async () => filter.setSearchText('nonexistent'));
    assert.equal(filter.processes.length, 0);

    await act(async () => root.unmount());
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
