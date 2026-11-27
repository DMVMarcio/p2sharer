//! Global Windows keyboard shortcuts for room voice mute and deafen toggles.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
#[cfg(windows)]
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use crate::remote_control::{join_hook_thread, HookThreadHandle, P2SHARER_INPUT_TAG};
use crate::remote_control::dom_code_to_vk;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSpec {
    pub code: String,
    pub ctrl_key: bool,
    pub shift_key: bool,
    pub alt_key: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VoiceShortcutAction {
    ToggleVoiceMute,
    ToggleVoiceDeafen,
}

impl VoiceShortcutAction {
    const fn as_str(self) -> &'static str {
        match self {
            Self::ToggleVoiceMute => "toggleVoiceMute",
            Self::ToggleVoiceDeafen => "toggleVoiceDeafen",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceShortcutTriggeredPayload {
    action: &'static str,
}

const FLAG_EXTENDED: u64 = 1 << 16;
const FLAG_CTRL: u64 = 1 << 17;
const FLAG_SHIFT: u64 = 1 << 18;
const FLAG_ALT: u64 = 1 << 19;
const FLAG_ENABLED: u64 = 1 << 31;

static MUTE_SHORTCUT: AtomicU64 = AtomicU64::new(0);
static DEAFEN_SHORTCUT: AtomicU64 = AtomicU64::new(0);
static PAUSED: AtomicBool = AtomicBool::new(false);
static HELD_MUTE_VK: AtomicU32 = AtomicU32::new(0);
static HELD_DEAFEN_VK: AtomicU32 = AtomicU32::new(0);

#[cfg(windows)]
static VOICE_SHORTCUT_GEN: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
static VOICE_SHORTCUT_TX: LazyLock<Mutex<Option<(u64, std::sync::mpsc::SyncSender<VoiceShortcutAction>)>>> =
    LazyLock::new(|| Mutex::new(None));
#[cfg(windows)]
static VOICE_HOOK_JOIN: LazyLock<Mutex<Option<HookThreadHandle>>> =
    LazyLock::new(|| Mutex::new(None));

#[cfg(windows)]
static CONFIG_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

pub(crate) fn encode_shortcut(spec: Option<&ShortcutSpec>) -> u64 {
    let Some(spec) = spec else {
        return 0;
    };
    let Some((vk, extended)) = dom_code_to_vk(spec.code.trim()) else {
        return 0;
    };
    let mut encoded = (vk as u64) | FLAG_ENABLED;
    if extended {
        encoded |= FLAG_EXTENDED;
    }
    if spec.ctrl_key {
        encoded |= FLAG_CTRL;
    }
    if spec.shift_key {
        encoded |= FLAG_SHIFT;
    }
    if spec.alt_key {
        encoded |= FLAG_ALT;
    }
    encoded
}

pub(crate) fn normalize_ll_vk(vk: u16, is_extended: bool) -> u16 {
    if is_extended {
        return vk;
    }
    // Windows translates Shift+Numpad into non-extended navigation VKs when NumLock is active.
    match vk {
        0x2D => 0x60, // Insert -> Numpad0
        0x23 => 0x61, // End -> Numpad1
        0x28 => 0x62, // Down -> Numpad2
        0x22 => 0x63, // PageDown -> Numpad3
        0x25 => 0x64, // Left -> Numpad4
        0x0C => 0x65, // Clear -> Numpad5
        0x27 => 0x66, // Right -> Numpad6
        0x24 => 0x67, // Home -> Numpad7
        0x26 => 0x68, // Up -> Numpad8
        0x21 => 0x69, // PageUp -> Numpad9
        0x2E => 0x6E, // Delete -> NumpadDecimal
        _ => vk,
    }
}

pub(crate) fn matches_encoded_shortcut(
    encoded: u64,
    vk: u16,
    is_extended: bool,
    ctrl_down: bool,
    shift_down: bool,
    alt_down: bool,
) -> bool {
    if (encoded & FLAG_ENABLED) == 0 {
        return false;
    }
    let target_vk = (encoded & 0xFFFF) as u16;
    let normalized_vk = normalize_ll_vk(vk, is_extended);
    if normalized_vk != target_vk {
        return false;
    }
    // Distinguish Enter vs NumpadEnter while staying tolerant of driver extended-flag differences on other keys.
    if normalized_vk == 0x0D && ((encoded & FLAG_EXTENDED) != 0) != is_extended {
        return false;
    }
    ((encoded & FLAG_CTRL) != 0) == ctrl_down
        && ((encoded & FLAG_SHIFT) != 0) == shift_down
        && ((encoded & FLAG_ALT) != 0) == alt_down
}

#[cfg(windows)]
unsafe extern "system" fn voice_shortcut_keyboard_proc(
    code: i32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, KBDLLHOOKSTRUCT, LLKHF_ALTDOWN, LLKHF_EXTENDED, WM_KEYDOWN, WM_KEYUP,
        WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    if code >= 0 {
        let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        if kb.dwExtraInfo != P2SHARER_INPUT_TAG {
            let is_extended = (kb.flags.0 & LLKHF_EXTENDED.0) != 0;
            let raw_vk = kb.vkCode as u16;
            let vk = normalize_ll_vk(raw_vk, is_extended);
            let vk_u32 = vk as u32;
            let msg = wparam.0 as u32;
            let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;

            if is_up {
                if HELD_MUTE_VK.load(Ordering::Acquire) == vk_u32 {
                    HELD_MUTE_VK.store(0, Ordering::Release);
                }
                if HELD_DEAFEN_VK.load(Ordering::Acquire) == vk_u32 {
                    HELD_DEAFEN_VK.store(0, Ordering::Release);
                }
            } else if down && !PAUSED.load(Ordering::Acquire) {
                let alt_down = (kb.flags.0 & LLKHF_ALTDOWN.0) != 0
                    || (GetAsyncKeyState(0x12) < 0)
                    || (GetAsyncKeyState(0xA4) < 0)
                    || (GetAsyncKeyState(0xA5) < 0);
                let ctrl_down = (GetAsyncKeyState(0x11) < 0)
                    || (GetAsyncKeyState(0xA2) < 0)
                    || (GetAsyncKeyState(0xA3) < 0);
                let shift_down = (GetAsyncKeyState(0x10) < 0)
                    || (GetAsyncKeyState(0xA0) < 0)
                    || (GetAsyncKeyState(0xA1) < 0);

                if matches_encoded_shortcut(
                    MUTE_SHORTCUT.load(Ordering::Acquire),
                    vk,
                    is_extended,
                    ctrl_down,
                    shift_down,
                    alt_down,
                ) && HELD_MUTE_VK.swap(vk_u32, Ordering::AcqRel) != vk_u32
                {
                    if let Ok(guard) = VOICE_SHORTCUT_TX.try_lock() {
                        if let Some((_, tx)) = guard.as_ref() {
                            let _ = tx.try_send(VoiceShortcutAction::ToggleVoiceMute);
                        }
                    }
                }

                if matches_encoded_shortcut(
                    DEAFEN_SHORTCUT.load(Ordering::Acquire),
                    vk,
                    is_extended,
                    ctrl_down,
                    shift_down,
                    alt_down,
                ) && HELD_DEAFEN_VK.swap(vk_u32, Ordering::AcqRel) != vk_u32
                {
                    if let Ok(guard) = VOICE_SHORTCUT_TX.try_lock() {
                        if let Some((_, tx)) = guard.as_ref() {
                            let _ = tx.try_send(VoiceShortcutAction::ToggleVoiceDeafen);
                        }
                    }
                }
            }
        }
    }

    CallNextHookEx(None, code, wparam, lparam)
}

#[cfg(windows)]
fn teardown_hook_locked() {
    MUTE_SHORTCUT.store(0, Ordering::Release);
    DEAFEN_SHORTCUT.store(0, Ordering::Release);
    PAUSED.store(false, Ordering::Release);
    HELD_MUTE_VK.store(0, Ordering::Release);
    HELD_DEAFEN_VK.store(0, Ordering::Release);
    if let Ok(mut tx_guard) = VOICE_SHORTCUT_TX.lock() {
        *tx_guard = None;
    }
    if let Ok(mut hook_guard) = VOICE_HOOK_JOIN.lock() {
        if let Some(handle) = hook_guard.take() {
            join_hook_thread(handle);
        }
    }
}

#[cfg(windows)]
fn ensure_hook_running(app: &AppHandle) -> Result<(), String> {
    use std::sync::Arc;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, PeekMessageW, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, MSG, PM_NOREMOVE, WH_KEYBOARD_LL,
    };

    let mut hook_guard = VOICE_HOOK_JOIN
        .lock()
        .map_err(|_| "Voice shortcut hook lock poisoned".to_string())?;
    let thread_alive = hook_guard
        .as_ref()
        .is_some_and(|handle| !handle.join.is_finished());
    let sender_ready = VOICE_SHORTCUT_TX
        .lock()
        .ok()
        .is_some_and(|tx| tx.is_some());
    if thread_alive && sender_ready {
        return Ok(());
    }

    if let Some(handle) = hook_guard.take() {
        join_hook_thread(handle);
    }

    let gen = VOICE_SHORTCUT_GEN.fetch_add(1, Ordering::AcqRel) + 1;
    let (tx, rx) = std::sync::mpsc::sync_channel::<VoiceShortcutAction>(32);
    *VOICE_SHORTCUT_TX
        .lock()
        .map_err(|_| "Voice shortcut channel lock poisoned".to_string())? = Some((gen, tx));

    let emitter_app = app.clone();
    std::thread::spawn(move || {
        while let Ok(action) = rx.recv() {
            let _ = emitter_app.emit_to(
                "main",
                "voice-global-shortcut",
                VoiceShortcutTriggeredPayload {
                    action: action.as_str(),
                },
            );
        }
    });

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<(u32, bool)>(1);
    let join = std::thread::spawn(move || unsafe {
        let tid = GetCurrentThreadId();
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        let hook = SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(voice_shortcut_keyboard_proc),
            None,
            0,
        );
        let ok = hook.is_ok() && !thread_stop.load(Ordering::Acquire);
        let _ = ready_tx.send((tid, ok));
        if let Ok(h) = hook {
            if ok {
                while !thread_stop.load(Ordering::Acquire)
                    && GetMessageW(&mut msg, None, 0, 0).as_bool()
                {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            let _ = UnhookWindowsHookEx(h);
        }
    });

    let (thread_id, hook_ok) = ready_rx
        .recv_timeout(std::time::Duration::from_millis(1200))
        .unwrap_or((0, false));
    if !hook_ok || thread_id == 0 {
        stop.store(true, Ordering::Release);
        let _ = join.join();
        if let Ok(mut tx_guard) = VOICE_SHORTCUT_TX.lock() {
            if tx_guard.as_ref().is_some_and(|(id, _)| *id == gen) {
                *tx_guard = None;
            }
        }
        return Err("Failed to register Windows global voice shortcut hook".into());
    }

    *hook_guard = Some(HookThreadHandle {
        thread_id,
        stop,
        join,
    });
    Ok(())
}

#[tauri::command]
pub fn configure_voice_shortcuts(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    toggle_mute: Option<ShortcutSpec>,
    toggle_deafen: Option<ShortcutSpec>,
    paused: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can configure voice shortcuts".into());
    }

    let mute_encoded = encode_shortcut(toggle_mute.as_ref());
    let deafen_encoded = encode_shortcut(toggle_deafen.as_ref());

    #[cfg(windows)]
    {
        let _guard = CONFIG_LOCK
            .lock()
            .map_err(|_| "Voice shortcut configuration lock poisoned".to_string())?;
        HELD_MUTE_VK.store(0, Ordering::Release);
        HELD_DEAFEN_VK.store(0, Ordering::Release);

        if mute_encoded == 0 && deafen_encoded == 0 {
            teardown_hook_locked();
            return Ok(());
        }

        MUTE_SHORTCUT.store(mute_encoded, Ordering::Release);
        DEAFEN_SHORTCUT.store(deafen_encoded, Ordering::Release);
        PAUSED.store(paused, Ordering::Release);
        ensure_hook_running(&app)?;
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        MUTE_SHORTCUT.store(mute_encoded, Ordering::Release);
        DEAFEN_SHORTCUT.store(deafen_encoded, Ordering::Release);
        PAUSED.store(paused, Ordering::Release);
    }

    Ok(())
}

pub fn shutdown() {
    #[cfg(windows)]
    {
        if let Ok(_guard) = CONFIG_LOCK.lock() {
            teardown_hook_locked();
        } else {
            teardown_hook_locked();
        }
    }
    #[cfg(not(windows))]
    {
        MUTE_SHORTCUT.store(0, Ordering::Release);
        DEAFEN_SHORTCUT.store(0, Ordering::Release);
        PAUSED.store(false, Ordering::Release);
        HELD_MUTE_VK.store(0, Ordering::Release);
        HELD_DEAFEN_VK.store(0, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_and_matches_global_voice_shortcuts_with_modifiers_and_unbound_state() {
        assert_eq!(encode_shortcut(None), 0);

        let unknown = ShortcutSpec {
            code: "NonExistentKey".into(),
            ctrl_key: true,
            shift_key: false,
            alt_key: false,
        };
        assert_eq!(encode_shortcut(Some(&unknown)), 0);

        let f9 = ShortcutSpec {
            code: "F9".into(),
            ctrl_key: false,
            shift_key: false,
            alt_key: false,
        };
        let f9_encoded = encode_shortcut(Some(&f9));
        assert_ne!(f9_encoded, 0);
        assert!(matches_encoded_shortcut(f9_encoded, 0x78, false, false, false, false));
        assert!(!matches_encoded_shortcut(f9_encoded, 0x78, false, true, false, false));

        let ctrl_shift_m = ShortcutSpec {
            code: "KeyM".into(),
            ctrl_key: true,
            shift_key: true,
            alt_key: false,
        };
        let combo_encoded = encode_shortcut(Some(&ctrl_shift_m));
        assert!(matches_encoded_shortcut(combo_encoded, b'M' as u16, false, true, true, false));
        assert!(!matches_encoded_shortcut(combo_encoded, b'M' as u16, false, true, false, false));

        let enter = ShortcutSpec {
            code: "Enter".into(),
            ctrl_key: false,
            shift_key: false,
            alt_key: true,
        };
        let numpad_enter = ShortcutSpec {
            code: "NumpadEnter".into(),
            ctrl_key: false,
            shift_key: false,
            alt_key: true,
        };
        let enter_encoded = encode_shortcut(Some(&enter));
        let numpad_encoded = encode_shortcut(Some(&numpad_enter));
        assert!(matches_encoded_shortcut(enter_encoded, 0x0D, false, false, false, true));
        assert!(!matches_encoded_shortcut(enter_encoded, 0x0D, true, false, false, true));
        assert!(matches_encoded_shortcut(numpad_encoded, 0x0D, true, false, false, true));
        assert!(!matches_encoded_shortcut(numpad_encoded, 0x0D, false, false, false, true));

        let shift_numpad1 = ShortcutSpec {
            code: "Numpad1".into(),
            ctrl_key: false,
            shift_key: true,
            alt_key: false,
        };
        let shift_numpad1_encoded = encode_shortcut(Some(&shift_numpad1));
        assert!(matches_encoded_shortcut(shift_numpad1_encoded, 0x23, false, false, true, false));
        assert!(!matches_encoded_shortcut(shift_numpad1_encoded, 0x23, true, false, true, false));

        let triple_mod = ShortcutSpec {
            code: "KeyD".into(),
            ctrl_key: true,
            shift_key: true,
            alt_key: true,
        };
        let triple_encoded = encode_shortcut(Some(&triple_mod));
        assert!(matches_encoded_shortcut(triple_encoded, b'D' as u16, false, true, true, true));
        assert!(!matches_encoded_shortcut(triple_encoded, b'D' as u16, false, true, true, false));
    }
}
