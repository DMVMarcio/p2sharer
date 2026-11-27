import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  loadInputBindings,
  matchesShortcut,
  subscribeInputBindings,
  type InputBindingsConfig,
  type VoiceShortcutAction,
} from '../core/ui/input_bindings.ts';
import { logDiagnostic } from '../core/logger.ts';
import { roomService } from './room_service.ts';

interface VoiceShortcutPayload {
  action?: string;
}

let activeBindings: InputBindingsConfig | null = null;
let capturePaused = false;

function handleVoiceShortcutAction(action: string | undefined): void {
  if (capturePaused) return;
  if (action === 'toggleVoiceMute') {
    void roomService.toggleVoiceMute();
  } else if (action === 'toggleVoiceDeafen') {
    roomService.toggleVoiceDeafen();
  }
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean((target as HTMLElement).isContentEditable || target.closest('[contenteditable="true"]'));
}

function syncNativeVoiceShortcuts(bindings: InputBindingsConfig | null): void {
  if (!isTauri()) return;
  void invoke('configure_voice_shortcuts', {
    toggleMute: bindings?.shortcuts.toggleVoiceMute ?? null,
    toggleDeafen: bindings?.shortcuts.toggleVoiceDeafen ?? null,
    paused: capturePaused,
  }).catch((err) => {
    logDiagnostic('WARN', 'voice.shortcuts', 'Could not configure global voice shortcuts', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** Pauses global voice shortcut execution while Settings is capturing a key binding. */
export function setVoiceShortcutCapturePaused(paused: boolean): void {
  if (capturePaused === paused) return;
  capturePaused = paused;
  syncNativeVoiceShortcuts(activeBindings ?? loadInputBindings());
}

/** Only MainApp calls this so auxiliary windows never duplicate global voice shortcuts. */
export function startVoiceShortcuts(): () => void {
  let disposed = false;
  activeBindings = loadInputBindings();

  const unsubscribeBindings = subscribeInputBindings((next) => {
    activeBindings = next;
    syncNativeVoiceShortcuts(next);
  });

  if (isTauri()) {
    let unlisten: (() => void) | undefined;
    void listen<VoiceShortcutPayload>('voice-global-shortcut', (event) => {
      if (!disposed) {
        handleVoiceShortcutAction(event.payload?.action);
      }
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    }).catch(() => {});

    syncNativeVoiceShortcuts(activeBindings);

    return () => {
      disposed = true;
      unsubscribeBindings();
      unlisten?.();
      syncNativeVoiceShortcuts(null);
    };
  }

  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (capturePaused || event.repeat) return;
    const hasModifier = event.ctrlKey || event.altKey || event.metaKey;
    if (!hasModifier && isEditableEventTarget(event.target)) return;
    const shortcuts = (activeBindings ?? loadInputBindings()).shortcuts;
    if (matchesShortcut(event, shortcuts.toggleVoiceMute)) {
      event.preventDefault();
      handleVoiceShortcutAction('toggleVoiceMute');
    }
    if (matchesShortcut(event, shortcuts.toggleVoiceDeafen)) {
      event.preventDefault();
      handleVoiceShortcutAction('toggleVoiceDeafen');
    }
  };

  window.addEventListener('keydown', onWindowKeyDown);
  return () => {
    disposed = true;
    unsubscribeBindings();
    window.removeEventListener('keydown', onWindowKeyDown);
  };
}

export function triggerVoiceShortcutForTest(action: VoiceShortcutAction): void {
  handleVoiceShortcutAction(action);
}
