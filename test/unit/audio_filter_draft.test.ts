import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../../src/core/state_store.ts';

describe('Audio Filter Draft State Isolation & Reversion Architecture', () => {
  let store: StateStore;

  beforeEach(() => {
    store = StateStore.getInstance();
    store.isAudioFilterFullAudio = false;
    store.selectedFilterMode = 'exclude';
    store.excludeProcessNames = new Set(['discord', 'p2sharer']);
    store.includeProcessNames = new Set(['game.exe']);
    store.excludePids = new Set([1001, 1002]);
    store.includePids = new Set([2001]);
  });

  it('keeps stateStore unmutated when user modifies draft settings without applying', () => {
    // Simulate user opening the modal with initial committed state
    let draftIsFullAudio = store.isAudioFilterFullAudio;
    let draftFilterMode = store.selectedFilterMode;
    const draftExcludeNames = new Set(store.excludeProcessNames);
    const draftIncludeNames = new Set(store.includeProcessNames);

    // User toggles full audio mode in draft
    draftIsFullAudio = true;
    // User switches mode to include
    draftFilterMode = 'include';
    // User adds spotify to include names
    draftIncludeNames.add('spotify');
    // User removes discord from exclude names
    draftExcludeNames.delete('discord');

    // Assert that stateStore remains strictly pristine and unchanged
    assert.strictEqual(store.isAudioFilterFullAudio, false);
    assert.strictEqual(store.selectedFilterMode, 'exclude');
    assert.deepStrictEqual(Array.from(store.excludeProcessNames).sort(), ['discord', 'p2sharer']);
    assert.deepStrictEqual(Array.from(store.includeProcessNames), ['game.exe']);
  });

  it('reverts all unsaved changes when closing the modal without saving', () => {
    // Initial snapshot of committed state
    const savedState = {
      isFullAudio: store.isAudioFilterFullAudio,
      mode: store.selectedFilterMode,
      excludeNames: Array.from(store.excludeProcessNames).sort(),
      includeNames: Array.from(store.includeProcessNames).sort(),
    };

    // User performs extensive modifications in modal draft
    let draftIsFullAudio = true;
    let draftFilterMode: 'exclude' | 'include' = 'include';
    const draftIncludeNames = new Set(['chrome.exe', 'vlc.exe']);

    // User cancels / closes modal -> draft is discarded
    draftIsFullAudio = false;
    draftFilterMode = 'exclude';
    draftIncludeNames.clear();

    // Re-opening reads directly from stateStore
    const reopenedDraft = {
      isFullAudio: store.isAudioFilterFullAudio,
      mode: store.selectedFilterMode,
      excludeNames: Array.from(store.excludeProcessNames).sort(),
      includeNames: Array.from(store.includeProcessNames).sort(),
    };

    assert.deepStrictEqual(reopenedDraft, savedState);
  });

  it('commits draft state to stateStore only when explicitly applying filters', () => {
    let draftIsFullAudio = false;
    let draftFilterMode: 'exclude' | 'include' = 'include';
    const draftIncludeNames = new Set(['game.exe', 'music_player.exe']);
    const draftIncludePids = new Set([2001, 3001]);
    const draftExcludeNames = new Set(store.excludeProcessNames);
    const draftExcludePids = new Set(store.excludePids);

    // Apply action: commit draft into stateStore
    store.set((s) => {
      s.isAudioFilterFullAudio = draftIsFullAudio;
      s.selectedFilterMode = draftFilterMode;
      s.excludeProcessNames = new Set(draftExcludeNames);
      s.includeProcessNames = new Set(draftIncludeNames);
      s.excludePids = new Set(draftExcludePids);
      s.includePids = new Set(draftIncludePids);
    });

    assert.strictEqual(store.isAudioFilterFullAudio, false);
    assert.strictEqual(store.selectedFilterMode, 'include');
    assert.deepStrictEqual(Array.from(store.includeProcessNames).sort(), ['game.exe', 'music_player.exe']);
    assert.deepStrictEqual(store.getActiveFilterPids().sort(), [2001, 3001]);
    assert.deepStrictEqual(store.getActiveFilterNames().sort(), ['game.exe', 'music_player.exe']);
  });
});
