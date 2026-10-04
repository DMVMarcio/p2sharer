import { t } from '../i18n/index.ts';
import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { stateStore } from '../core/state_store';
import { ProcessItem } from '../core/types';
import { showToast } from './useToast';

export function useAudioFilter() {
  const [selectedFilterMode, setSelectedFilterMode] = useState<'exclude' | 'include'>(
    () => stateStore.selectedFilterMode
  );
  const [isFullAudio, setIsFullAudio] = useState<boolean>(
    () => stateStore.isAudioFilterFullAudio
  );
  const [processes, setProcesses] = useState<ProcessItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [searchText, setSearchText] = useState<string>('');

  // Local draft selections initialized from persistent stateStore
  const [draftExcludeNames, setDraftExcludeNames] = useState<Set<string>>(
    () => new Set(stateStore.excludeProcessNames)
  );
  const [draftIncludeNames, setDraftIncludeNames] = useState<Set<string>>(
    () => new Set(stateStore.includeProcessNames)
  );
  const [draftExcludePids, setDraftExcludePids] = useState<Set<number>>(
    () => new Set(stateStore.excludePids)
  );
  const [draftIncludePids, setDraftIncludePids] = useState<Set<number>>(
    () => new Set(stateStore.includePids)
  );

  const draftExcludeNamesRef = useRef(draftExcludeNames);
  draftExcludeNamesRef.current = draftExcludeNames;
  const draftIncludeNamesRef = useRef(draftIncludeNames);
  draftIncludeNamesRef.current = draftIncludeNames;

  const loadProcesses = useCallback(async () => {
    setIsLoading(true);
    try {
      const items = await invoke<ProcessItem[]>('list_audio_processes');
      setProcesses(items);

      const exNames = draftExcludeNamesRef.current;
      const inNames = draftIncludeNamesRef.current;
      const exPids = new Set<number>();
      const inPids = new Set<number>();

      items.forEach((p) => {
        const nameLower = p.name.toLowerCase();
        if (exNames.has(nameLower)) exPids.add(p.pid);
        if (inNames.has(nameLower)) inPids.add(p.pid);
      });

      setDraftExcludePids(exPids);
      setDraftIncludePids(inPids);
    } catch (err) {
      console.error('Failed to list processes:', err);
      showToast(t("message.67523526cb3c"));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setFilterMode = useCallback((mode: 'exclude' | 'include') => {
    setSelectedFilterMode(mode);
  }, []);

  const setFullAudioMode = useCallback((enabled: boolean) => {
    setIsFullAudio(enabled);
  }, []);

  const toggleProcess = useCallback(
    (item: ProcessItem, checked: boolean) => {
      const nameLower = item.name.toLowerCase();
      if (selectedFilterMode === 'exclude') {
        setDraftExcludeNames((prev) => {
          const next = new Set(prev);
          if (checked) next.add(nameLower);
          else next.delete(nameLower);
          return next;
        });
        setDraftExcludePids((prev) => {
          const next = new Set(prev);
          processes.forEach((p) => {
            if (p.name.toLowerCase() === nameLower) {
              if (checked) next.add(p.pid);
              else next.delete(p.pid);
            }
          });
          return next;
        });
      } else {
        setDraftIncludeNames((prev) => {
          const next = new Set(prev);
          if (checked) next.add(nameLower);
          else next.delete(nameLower);
          return next;
        });
        setDraftIncludePids((prev) => {
          const next = new Set(prev);
          processes.forEach((p) => {
            if (p.name.toLowerCase() === nameLower) {
              if (checked) next.add(p.pid);
              else next.delete(p.pid);
            }
          });
          return next;
        });
      }
    },
    [selectedFilterMode, processes]
  );

  const selectSingleProcess = useCallback(
    (item: ProcessItem) => {
      const nameLower = item.name.toLowerCase();
      if (selectedFilterMode === 'exclude') {
        setDraftExcludeNames(new Set([nameLower]));
        setDraftExcludePids(new Set([item.pid]));
      } else {
        setDraftIncludeNames(new Set([nameLower]));
        setDraftIncludePids(new Set([item.pid]));
      }
    },
    [selectedFilterMode]
  );

  const clearSelection = useCallback(() => {
    if (selectedFilterMode === 'exclude') {
      setDraftExcludeNames(new Set());
      setDraftExcludePids(new Set());
    } else {
      setDraftIncludeNames(new Set());
      setDraftIncludePids(new Set());
    }
  }, [selectedFilterMode]);

  const selectVoiceApps = useCallback(() => {
    const nextNames = new Set<string>();
    const nextPids = new Set<number>();

    processes.forEach((p) => {
      if (p.is_likely_chat_or_voice) {
        nextNames.add(p.name.toLowerCase());
        nextPids.add(p.pid);
      }
    });

    if (selectedFilterMode === 'exclude') {
      setDraftExcludeNames(nextNames);
      setDraftExcludePids(nextPids);
    } else {
      setDraftIncludeNames(nextNames);
      setDraftIncludePids(nextPids);
    }
  }, [processes, selectedFilterMode]);

  const applyFilters = useCallback(async () => {
    // 1. Commit draft state to persistent store and localStorage
    stateStore.set((s) => {
      s.isAudioFilterFullAudio = isFullAudio;
      s.selectedFilterMode = selectedFilterMode;
      s.excludeProcessNames = new Set(draftExcludeNames);
      s.includeProcessNames = new Set(draftIncludeNames);
      s.excludePids = new Set(draftExcludePids);
      s.includePids = new Set(draftIncludePids);
      s.saveAudioFilterPresets();
    });

    const pidsArray = Array.from(selectedFilterMode === 'exclude' ? draftExcludePids : draftIncludePids);
    const namesArray = Array.from(selectedFilterMode === 'exclude' ? draftExcludeNames : draftIncludeNames);
    const count = namesArray.length || pidsArray.length;

    let successMsg = '';
    if (isFullAudio) {
      successMsg = t("message.bd5c0e60c469");
    } else if (selectedFilterMode === 'exclude') {
      successMsg =
        count === 0
          ? t("message.0fab559c6e07")
          : t("message.d192e7d09169", { v0: count });
    } else {
      successMsg =
        count === 0
          ? t("message.37b4e4fade16")
          : t("message.8a536acf951b", { v0: count });
    }

    // 2. Only dispatch updated config to backend audio capture engine IF actively sharing screen.
    // If not streaming, presets are saved in store and will be activated when screen sharing begins.
    if (!stateStore.isSharingScreen) {
      showToast(successMsg);
      return true;
    }

    if (isFullAudio) {
      try {
        await invoke('start_audio_capture', {
          config: {
            mode: 'full',
            target_pids: [],
            target_names: [],
            sample_rate: 48000,
          },
        });
        showToast(successMsg);
        return true;
      } catch (err) {
        console.error('Error applying audio filter:', err);
        showToast(t("message.e6c4f27405a7"));
        return false;
      }
    }

    try {
      await invoke('start_audio_capture', {
        config: {
          mode: selectedFilterMode,
          target_pids: pidsArray,
          target_names: namesArray,
          sample_rate: 48000,
        },
      });
      showToast(successMsg);
      return true;
    } catch (err) {
      console.error('Error applying audio filter:', err);
      showToast(t("message.e6c4f27405a7"));
      return false;
    }
  }, [
    isFullAudio,
    selectedFilterMode,
    draftExcludeNames,
    draftIncludeNames,
    draftExcludePids,
    draftIncludePids,
  ]);

  const filteredProcesses = processes.filter((p) => {
    if (!searchText) return true;
    const lower = searchText.toLowerCase();
    return (
      p.name.toLowerCase().includes(lower) ||
      (p.window_title && p.window_title.toLowerCase().includes(lower)) ||
      p.pid.toString().includes(lower)
    );
  });

  const selectedNames = selectedFilterMode === 'exclude' ? draftExcludeNames : draftIncludeNames;
  const selectedPids = selectedFilterMode === 'exclude' ? draftExcludePids : draftIncludePids;

  return {
    processes: filteredProcesses,
    rawProcessCount: processes.length,
    isLoading,
    searchText,
    setSearchText,
    isFullAudio,
    setFullAudioMode,
    selectedFilterMode,
    setFilterMode,
    selectedPids,
    selectedNames,
    toggleProcess,
    selectSingleProcess,
    selectVoiceApps,
    clearSelection,
    loadProcesses,
    applyFilters,
  };
}
