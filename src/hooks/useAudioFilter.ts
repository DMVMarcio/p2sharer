import { audioProcessKey, type AudioCaptureChoice } from '../core/audio_filter_presets.ts';
import { t } from '../i18n/index.ts';
import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { stateStore } from '../core/state_store';
import { ProcessItem } from '../core/types';
import { showToast } from './useToast';

export function getPidsForProcess(item: ProcessItem): number[] {
  const pids = new Set<number>();
  if (item.sub_processes && item.sub_processes.length > 0) {
    for (const sub of item.sub_processes) {
      if (typeof sub.pid === 'number' && sub.pid > 0) pids.add(sub.pid);
    }
  }
  if (typeof item.pid === 'number' && item.pid > 0) {
    pids.add(item.pid);
  }
  return Array.from(pids);
}

export function useAudioFilter() {
  const [selectedFilterMode, setSelectedFilterMode] = useState<'exclude' | 'include'>(
    () => stateStore.selectedFilterMode
  );
  const [isFullAudio, setIsFullAudio] = useState<boolean>(
    () => stateStore.isAudioFilterFullAudio
  );
  const [isAllMuted, setIsAllMuted] = useState(() => !stateStore.isAudioFilterFullAudio && stateStore.selectedFilterMode === 'include' && stateStore.includeProcessNames.size === 0 && stateStore.includePids.size === 0);
  const [processes, setProcesses] = useState<ProcessItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [searchText, setSearchText] = useState<string>('');

  // Local draft selections initialized from persistent stateStore
  const [draftExcludeNames, setDraftExcludeNames] = useState<Set<string>>(
    () => new Set(Array.from(stateStore.excludeProcessNames, audioProcessKey))
  );
  const [draftIncludeNames, setDraftIncludeNames] = useState<Set<string>>(
    () => new Set(Array.from(stateStore.includeProcessNames, audioProcessKey))
  );
  const [draftExcludePids, setDraftExcludePids] = useState<Set<number>>(
    () => new Set(stateStore.excludePids)
  );
  const [draftIncludePids, setDraftIncludePids] = useState<Set<number>>(
    () => new Set(stateStore.includePids)
  );

  // Freeze the opening selection/order so controls never move beneath the pointer.
  const openingSelection = useRef(new Set(Array.from(
    stateStore.selectedFilterMode === 'exclude' ? stateStore.excludeProcessNames : stateStore.includeProcessNames,
    audioProcessKey,
  )));
  const processOrder = useRef<Map<string, number> | null>(null);
  const draftExcludeNamesRef = useRef(draftExcludeNames);
  draftExcludeNamesRef.current = draftExcludeNames;
  const draftIncludeNamesRef = useRef(draftIncludeNames);
    draftIncludeNamesRef.current = draftIncludeNames;
  const draftExcludePidsRef = useRef(draftExcludePids);
  draftExcludePidsRef.current = draftExcludePids;
  const draftIncludePidsRef = useRef(draftIncludePids);
  draftIncludePidsRef.current = draftIncludePids;

  const loadProcesses = useCallback(async () => {
    setIsLoading(true);
    try {
      const items = await invoke<ProcessItem[]>('list_audio_processes');
      if (!processOrder.current) {
        const initial = [...items].sort((a, b) => Number(openingSelection.current.has(audioProcessKey(b.name)))
          - Number(openingSelection.current.has(audioProcessKey(a.name))));
        processOrder.current = new Map(initial.map((item, index) => [audioProcessKey(item.name), index]));
      }
      const order = processOrder.current;
      const ordered = [...items].sort((a, b) => (order.get(audioProcessKey(a.name)) ?? Number.MAX_SAFE_INTEGER)
        - (order.get(audioProcessKey(b.name)) ?? Number.MAX_SAFE_INTEGER));
      ordered.forEach(item => { const key = audioProcessKey(item.name); if (!order.has(key)) order.set(key, order.size); });
      setProcesses(ordered);

      const exNames = draftExcludeNamesRef.current;
      const inNames = draftIncludeNamesRef.current;
      const exPids = new Set<number>();
      const inPids = new Set<number>();

      items.forEach((p) => {
        const nameLower = audioProcessKey(p.name);
        const pids = getPidsForProcess(p);
        if (exNames.has(nameLower)) {
          pids.forEach(pid => exPids.add(pid));
        } else {
          pids.forEach(pid => {
            if (draftExcludePidsRef.current.has(pid)) exPids.add(pid);
          });
        }
        if (inNames.has(nameLower)) {
          pids.forEach(pid => inPids.add(pid));
        } else {
          pids.forEach(pid => {
            if (draftIncludePidsRef.current.has(pid)) inPids.add(pid);
          });
        }
      });

      setDraftExcludePids(exPids);
      setDraftIncludePids(inPids);
    } catch (err) {
      console.error('Failed to list processes:', err);
      showToast(t("message.67523526cb3c"), 3500, 'error');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setCaptureChoice = useCallback((choice: AudioCaptureChoice) => {
    setIsFullAudio(choice === 'full');
    setIsAllMuted(choice === 'none');
    if (choice === 'include' || choice === 'exclude') setSelectedFilterMode(choice);
  }, []);

  const setFilterMode = useCallback((mode: 'exclude' | 'include') => {
    setSelectedFilterMode(mode);
    setIsAllMuted(false);
  }, []);

  const setFullAudioMode = useCallback((enabled: boolean) => {
    setIsFullAudio(enabled);
    setIsAllMuted(false);
  }, []);

  const toggleProcess = useCallback(
    (item: ProcessItem, checked: boolean) => {
      const nameLower = audioProcessKey(item.name);
      const targetPids = new Set<number>();
      processes.forEach((p) => {
        if (audioProcessKey(p.name) === nameLower) {
          getPidsForProcess(p).forEach(pid => targetPids.add(pid));
        }
      });
      if (targetPids.size === 0) {
        getPidsForProcess(item).forEach(pid => targetPids.add(pid));
      }

      if (selectedFilterMode === 'exclude') {
        setDraftExcludeNames((prev) => {
          const next = new Set(prev);
          if (checked) next.add(nameLower);
          else next.delete(nameLower);
          return next;
        });
        setDraftExcludePids((prev) => {
          const next = new Set(prev);
          targetPids.forEach(pid => {
            if (checked) next.add(pid);
            else next.delete(pid);
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
          targetPids.forEach(pid => {
            if (checked) next.add(pid);
            else next.delete(pid);
          });
          return next;
        });
      }
    },
    [selectedFilterMode, processes]
  );

  const toggleSubProcess = useCallback(
    (item: ProcessItem, pid: number, checked: boolean) => {
      const nameLower = audioProcessKey(item.name);
      const allPids = new Set<number>();
      processes.forEach((p) => {
        if (audioProcessKey(p.name) === nameLower) {
          getPidsForProcess(p).forEach(pId => allPids.add(pId));
        }
      });
      if (allPids.size === 0) {
        getPidsForProcess(item).forEach(pId => allPids.add(pId));
      }
      const allPidsArray = Array.from(allPids);

      if (selectedFilterMode === 'exclude') {
        setDraftExcludePids((prev) => {
          const next = new Set(prev);
          if (checked) next.add(pid);
          else next.delete(pid);

          const allSelected = allPidsArray.length > 0 && allPidsArray.every(p => next.has(p));
          setDraftExcludeNames((prevNames) => {
            const nextNames = new Set(prevNames);
            if (allSelected) {
              nextNames.add(nameLower);
            } else {
              nextNames.delete(nameLower);
            }
            return nextNames;
          });

          return next;
        });
      } else {
        setDraftIncludePids((prev) => {
          const next = new Set(prev);
          if (checked) next.add(pid);
          else next.delete(pid);

          const allSelected = allPidsArray.length > 0 && allPidsArray.every(p => next.has(p));
          setDraftIncludeNames((prevNames) => {
            const nextNames = new Set(prevNames);
            if (allSelected) {
              nextNames.add(nameLower);
            } else {
              nextNames.delete(nameLower);
            }
            return nextNames;
          });

          return next;
        });
      }
    },
    [selectedFilterMode, processes]
  );

  const getProcessSelectionState = useCallback(
    (item: ProcessItem): 'all' | 'none' | 'partial' => {
      const nameLower = audioProcessKey(item.name);
      const allPids = new Set<number>();
      processes.forEach((p) => {
        if (audioProcessKey(p.name) === nameLower) {
          getPidsForProcess(p).forEach(pId => allPids.add(pId));
        }
      });
      if (allPids.size === 0) {
        getPidsForProcess(item).forEach(pId => allPids.add(pId));
      }

      const selectedPidsSet = selectedFilterMode === 'exclude' ? draftExcludePids : draftIncludePids;
      const selectedNamesSet = selectedFilterMode === 'exclude' ? draftExcludeNames : draftIncludeNames;

      if (allPids.size === 0) {
        return selectedNamesSet.has(nameLower) ? 'all' : 'none';
      }

      let selectedCount = 0;
      for (const p of allPids) {
        if (selectedPidsSet.has(p)) selectedCount++;
      }

      if (selectedCount === 0) {
        return selectedNamesSet.has(nameLower) ? 'all' : 'none';
      }
      if (selectedCount === allPids.size) {
        return 'all';
      }
      return 'partial';
    },
    [selectedFilterMode, draftExcludePids, draftIncludePids, draftExcludeNames, draftIncludeNames, processes]
  );

  const selectSingleProcess = useCallback(
    (item: ProcessItem) => {
      const nameLower = audioProcessKey(item.name);
      const targetPids = new Set<number>();
      processes.forEach((p) => {
        if (audioProcessKey(p.name) === nameLower) {
          getPidsForProcess(p).forEach(pid => targetPids.add(pid));
        }
      });
      if (targetPids.size === 0) {
        getPidsForProcess(item).forEach(pid => targetPids.add(pid));
      }

      if (selectedFilterMode === 'exclude') {
        setDraftExcludeNames(new Set([nameLower]));
        setDraftExcludePids(targetPids);
      } else {
        setDraftIncludeNames(new Set([nameLower]));
        setDraftIncludePids(targetPids);
      }
    },
    [selectedFilterMode, processes]
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
        nextNames.add(audioProcessKey(p.name));
        getPidsForProcess(p).forEach(pid => nextPids.add(pid));
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
    const effectiveMode = isAllMuted ? 'include' : selectedFilterMode;
    const effectiveIncludeNames = isAllMuted ? new Set<string>() : draftIncludeNames;
    const effectiveIncludePids = isAllMuted ? new Set<number>() : draftIncludePids;
    // 1. Commit draft state to persistent store and localStorage
    stateStore.set((s) => {
      s.isAudioFilterFullAudio = isFullAudio;
      s.selectedFilterMode = effectiveMode;
      s.excludeProcessNames = new Set(draftExcludeNames);
      s.includeProcessNames = new Set(effectiveIncludeNames);
      s.excludePids = new Set(draftExcludePids);
      s.includePids = new Set(effectiveIncludePids);
      s.saveAudioFilterPresets();
    });

    const pidsArray = Array.from(effectiveMode === 'exclude' ? draftExcludePids : effectiveIncludePids);
    const namesArray = Array.from(effectiveMode === 'exclude' ? draftExcludeNames : effectiveIncludeNames);
    const count = namesArray.length || pidsArray.length;

    let successMsg = '';
    if (isFullAudio) {
      successMsg = t("message.bd5c0e60c469");
    } else if (effectiveMode === 'exclude') {
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
        showToast(t("message.e6c4f27405a7"), 3500, 'error');
        return false;
      }
    }

    try {
      await invoke('start_audio_capture', {
        config: {
          mode: effectiveMode,
          target_pids: pidsArray,
          target_names: namesArray,
          sample_rate: 48000,
        },
      });
      showToast(successMsg);
      return true;
    } catch (err) {
      console.error('Error applying audio filter:', err);
      showToast(t("message.e6c4f27405a7"), 3500, 'error');
      return false;
    }
  }, [
    isAllMuted,
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
    if (
      p.name.toLowerCase().includes(lower) ||
      (p.window_title && p.window_title.toLowerCase().includes(lower)) ||
      p.pid.toString().includes(lower)
    ) {
      return true;
    }
    if (p.sub_processes) {
      return p.sub_processes.some((sub) =>
        sub.pid.toString().includes(lower) ||
        (sub.window_title && sub.window_title.toLowerCase().includes(lower))
      );
    }
    return false;
  });

  const selectedNames = selectedFilterMode === 'exclude' ? draftExcludeNames : draftIncludeNames;
  const selectedPids = selectedFilterMode === 'exclude' ? draftExcludePids : draftIncludePids;

  return {
    captureChoice: (isFullAudio ? 'full' : isAllMuted ? 'none' : selectedFilterMode) as AudioCaptureChoice,
    setCaptureChoice,
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
    toggleSubProcess,
    getProcessSelectionState,
    selectSingleProcess,
    selectVoiceApps,
    clearSelection,
    loadProcesses,
    applyFilters,
  };
}
