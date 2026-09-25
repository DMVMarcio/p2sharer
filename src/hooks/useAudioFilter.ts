import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { stateStore } from '../core/state_store';
import { ProcessItem } from '../core/types';
import { useStore } from './useStore';
import { showToast } from './useToast';

export function useAudioFilter() {
  const selectedFilterMode = useStore((s) => s.selectedFilterMode);
  const [processes, setProcesses] = useState<ProcessItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [searchText, setSearchText] = useState<string>('');
  const [selectedPids, setSelectedPids] = useState<Set<number>>(new Set());
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());

  const loadProcesses = useCallback(async () => {
    setIsLoading(true);
    try {
      const items = await invoke<ProcessItem[]>('list_audio_processes');
      setProcesses(items);

      // Reconcile with saved active filter presets
      const isExclude = stateStore.selectedFilterMode === 'exclude';
      const activeNames = isExclude ? stateStore.excludeProcessNames : stateStore.includeProcessNames;
      const newPids = new Set<number>();
      const newNames = new Set<string>(activeNames);

      items.forEach((p) => {
        const nameLower = p.name.toLowerCase();
        if (activeNames.has(nameLower)) {
          newPids.add(p.pid);
        }
      });

      setSelectedPids(newPids);
      setSelectedNames(newNames);
    } catch (err) {
      console.error('Failed to list processes:', err);
      showToast('Erro ao carregar lista de aplicativos de áudio.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setFilterMode = useCallback((mode: 'exclude' | 'include') => {
    stateStore.set((s) => {
      s.selectedFilterMode = mode;
      s.saveAudioFilterPresets();
    });
    // Update local selection based on new mode
    const activeNames = mode === 'exclude' ? stateStore.excludeProcessNames : stateStore.includeProcessNames;
    setSelectedNames(new Set(activeNames));
  }, []);

  const toggleProcess = useCallback(
    (item: ProcessItem, checked: boolean) => {
      const nameLower = item.name.toLowerCase();
      const nextNames = new Set(selectedNames);
      const nextPids = new Set(selectedPids);

      if (checked) {
        nextNames.add(nameLower);
        processes.forEach((p) => {
          if (p.name.toLowerCase() === nameLower) {
            nextPids.add(p.pid);
          }
        });
      } else {
        nextNames.delete(nameLower);
        processes.forEach((p) => {
          if (p.name.toLowerCase() === nameLower) {
            nextPids.delete(p.pid);
          }
        });
      }

      setSelectedNames(nextNames);
      setSelectedPids(nextPids);

      stateStore.set((s) => {
        if (s.selectedFilterMode === 'exclude') {
          s.excludeProcessNames = nextNames;
          s.excludePids = nextPids;
        } else {
          s.includeProcessNames = nextNames;
          s.includePids = nextPids;
        }
        s.saveAudioFilterPresets();
      });
    },
    [processes, selectedNames, selectedPids]
  );

  const applyFilters = useCallback(async () => {
    const pidsArray = stateStore.getActiveFilterPids();
    const namesArray = stateStore.getActiveFilterNames();
    stateStore.saveAudioFilterPresets();

    try {
      await invoke('start_audio_capture', {
        config: {
          mode: stateStore.selectedFilterMode,
          target_pids: pidsArray,
          target_names: namesArray,
          sample_rate: 48000,
        },
      });
      const count = namesArray.length || pidsArray.length;
      const msg =
        stateStore.selectedFilterMode === 'exclude'
          ? `Filtro aplicado: Silenciando ${count} aplicativo(s)`
          : `Filtro aplicado: Transmitindo apenas ${count} aplicativo(s)`;
      showToast(msg);
      return true;
    } catch (err) {
      console.error('Error applying audio filter:', err);
      showToast('Erro ao aplicar filtros de áudio.');
      return false;
    }
  }, []);

  const filteredProcesses = processes.filter((p) => {
    if (!searchText) return true;
    const lower = searchText.toLowerCase();
    return (
      p.name.toLowerCase().includes(lower) ||
      (p.window_title && p.window_title.toLowerCase().includes(lower)) ||
      p.pid.toString().includes(lower)
    );
  });

  return {
    processes: filteredProcesses,
    isLoading,
    searchText,
    setSearchText,
    selectedFilterMode,
    setFilterMode,
    selectedPids,
    selectedNames,
    toggleProcess,
    loadProcesses,
    applyFilters,
  };
}
