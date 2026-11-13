use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const HOST_PRIORITY_MS: u64 = 1500;
const MONITOR_INTERVAL_MS: u64 = 16;
const P2SHARER_INPUT_TAG: usize = 0x5032_5348;
const HOST_MOUSE_JITTER_PX: i32 = 5;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemoteInputEvent {
    MouseMove {
        x: f64,
        y: f64,
    },
    MouseButton {
        button: String,
        down: bool,
        x: Option<f64>,
        y: Option<f64>,
    },
    MouseWheel {
        #[serde(rename = "deltaX")]
        delta_x: f64,
        #[serde(rename = "deltaY")]
        delta_y: f64,
        x: Option<f64>,
        y: Option<f64>,
    },
    Key {
        code: String,
        key: String,
        down: bool,
        repeat: Option<bool>,
        vk: Option<u16>,
        #[serde(rename = "ctrlKey")]
        ctrl_key: Option<bool>,
        #[serde(rename = "altKey")]
        alt_key: Option<bool>,
        #[serde(rename = "metaKey")]
        meta_key: Option<bool>,
    },
    ReleaseAll,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyInputResult {
    pub accepted: bool,
    pub host_busy: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostPriorityPayload {
    host_busy: bool,
    cursor_shape: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CursorSyncPayload {
    session_id: String,
    active: bool,
    visible: bool,
    x: f64,
    y: f64,
    cursor_shape: String,
    host_busy: bool,
    actor_controller_id: String,
    embedded_in_video: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImmersiveKeyPayload {
    vk: u16,
    code: String,
    key: String,
    down: bool,
}

struct CachedDesktopMapping {
    session_id: String,
    is_window: bool,
    source_bounds: (i32, i32, u32, u32),
    virtual_bounds: (i32, i32, i32, i32),
    refreshed_at_ms: u64,
}

struct HostControlState {
    active: bool,
    monitor_running: bool,
    last_self_input_tick: u32,
    last_self_cursor: Option<(i32, i32)>,
    last_hw_input_ms: u64,
    host_paused_until: u64,
    was_host_paused: bool,
    last_cursor_shape: String,
    last_session_id: Option<String>,
    last_mouse_actor_id: Option<String>,
    held_buttons: HashMap<String, HashSet<String>>,
    held_vks: HashMap<String, HashSet<u16>>,
    held_unicode: HashMap<(String, String), Vec<u16>>,
    mapping_cache: Option<CachedDesktopMapping>,
    perf_applied: u64,
    perf_busy_dropped: u64,
    perf_total_us: u64,
    perf_max_us: u64,
    perf_last_log_ms: u64,
}

impl Default for HostControlState {
    fn default() -> Self {
        Self {
            active: false,
            monitor_running: false,
            last_self_input_tick: 0,
            last_self_cursor: None,
            last_hw_input_ms: 0,
            host_paused_until: 0,
            was_host_paused: false,
            last_cursor_shape: "default".to_string(),
            last_session_id: None,
            last_mouse_actor_id: None,
            held_buttons: HashMap::new(),
            held_vks: HashMap::new(),
            held_unicode: HashMap::new(),
            mapping_cache: None,
            perf_applied: 0,
            perf_busy_dropped: 0,
            perf_total_us: 0,
            perf_max_us: 0,
            perf_last_log_ms: 0,
        }
    }
}

struct HookThreadHandle {
    thread_id: u32,
    stop: Arc<AtomicBool>,
    join: std::thread::JoinHandle<()>,
}

#[cfg(windows)]
fn join_hook_thread(handle: HookThreadHandle) {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};
    handle.stop.store(true, Ordering::Release);
    for _ in 0..25 {
        unsafe {
            let _ = PostThreadMessageW(handle.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if handle.join.is_finished() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(8));
    }
    if handle.join.is_finished() {
        let _ = handle.join.join();
    } else {
        // Detach instead of blocking IPC locks indefinitely if Windows delays pump exit.
        std::thread::spawn(move || {
            let _ = handle.join.join();
        });
    }
}

static HOST_STATE: LazyLock<Mutex<HostControlState>> =
    LazyLock::new(|| Mutex::new(HostControlState::default()));
static HOST_ACTIVE: AtomicBool = AtomicBool::new(false);
static HOST_PRIORITY_HOOK_ACTIVE: AtomicBool = AtomicBool::new(false);
static HOST_HARDWARE_INPUT_MS: AtomicU64 = AtomicU64::new(0);
// Stores (anchor_pt, last_hw_pt) so controller SendInput jumps reset the anchor and only true host movement triggers priority pause.
static HOST_LAST_HW_CURSOR: LazyLock<Mutex<Option<((i32, i32), (i32, i32))>>> =
    LazyLock::new(|| Mutex::new(None));
static HOST_PRIORITY_HOOK_JOIN: LazyLock<Mutex<Option<HookThreadHandle>>> =
    LazyLock::new(|| Mutex::new(None));

static IMMERSIVE_ENABLED: AtomicBool = AtomicBool::new(false);
static IMMERSIVE_TARGET_HWND: AtomicIsize = AtomicIsize::new(0);
static IMMERSIVE_HELD_MASK: AtomicU32 = AtomicU32::new(0);
static IMMERSIVE_TARGET_LABEL: LazyLock<Mutex<String>> =
    LazyLock::new(|| Mutex::new("main".to_string()));
static IMMERSIVE_TX: LazyLock<Mutex<Option<std::sync::mpsc::SyncSender<ImmersiveKeyPayload>>>> =
    LazyLock::new(|| Mutex::new(None));
static IMMERSIVE_HOOK_JOIN: LazyLock<Mutex<Option<HookThreadHandle>>> =
    LazyLock::new(|| Mutex::new(None));
static CURSOR_CLIP_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn is_host_control_active() -> bool {
    HOST_ACTIVE.load(Ordering::Relaxed)
}

pub fn should_suppress_captured_cursor() -> bool {
    HOST_ACTIVE.load(Ordering::Relaxed)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(windows)]
fn read_last_input_tick() -> u32 {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    unsafe {
        if GetLastInputInfo(&mut info).as_bool() {
            info.dwTime
        } else {
            0
        }
    }
}

#[cfg(windows)]
fn read_cursor_pos() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT::default();
    unsafe {
        if GetCursorPos(&mut pt).is_ok() {
            Some((pt.x, pt.y))
        } else {
            None
        }
    }
}

#[cfg(windows)]
fn read_cursor_shape() -> String {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorInfo, LoadCursorW, CURSORINFO, CURSOR_SHOWING, IDC_APPSTARTING, IDC_ARROW,
        IDC_CROSS, IDC_HAND, IDC_IBEAM, IDC_NO, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS,
        IDC_SIZENWSE, IDC_SIZEWE, IDC_WAIT,
    };
    let mut ci = CURSORINFO {
        cbSize: std::mem::size_of::<CURSORINFO>() as u32,
        ..Default::default()
    };
    unsafe {
        if GetCursorInfo(&mut ci).is_err() {
            return "default".to_string();
        }
        if (ci.flags.0 & CURSOR_SHOWING.0) == 0 {
            return "default".to_string();
        }
        let h = ci.hCursor;
        let matches = |id| LoadCursorW(None, id).map(|c| c == h).unwrap_or(false);
        if matches(IDC_IBEAM) {
            "text".to_string()
        } else if matches(IDC_HAND) {
            "pointer".to_string()
        } else if matches(IDC_WAIT) {
            "wait".to_string()
        } else if matches(IDC_APPSTARTING) {
            "progress".to_string()
        } else if matches(IDC_CROSS) {
            "crosshair".to_string()
        } else if matches(IDC_SIZEWE) {
            "ew-resize".to_string()
        } else if matches(IDC_SIZENS) {
            "ns-resize".to_string()
        } else if matches(IDC_SIZENWSE) {
            "nwse-resize".to_string()
        } else if matches(IDC_SIZENESW) {
            "nesw-resize".to_string()
        } else if matches(IDC_SIZEALL) {
            "move".to_string()
        } else if matches(IDC_NO) {
            "not-allowed".to_string()
        } else if matches(IDC_ARROW) {
            "default".to_string()
        } else {
            "default".to_string()
        }
    }
}

#[cfg(windows)]
fn send_win32_inputs(inputs: &[windows::Win32::UI::Input::KeyboardAndMouse::INPUT]) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT};
    if inputs.is_empty() {
        return;
    }
    unsafe {
        let _ = SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(windows)]
fn make_mouse_button_input(
    button: &str,
    down: bool,
    abs_pos: Option<(i32, i32)>,
) -> Option<windows::Win32::UI::Input::KeyboardAndMouse::INPUT> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
        MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_XDOWN,
        MOUSEEVENTF_XUP, MOUSEINPUT,
    };
    let (mut flags, mouse_data) = match (button, down) {
        ("left", true) => (MOUSEEVENTF_LEFTDOWN, 0u32),
        ("left", false) => (MOUSEEVENTF_LEFTUP, 0u32),
        ("right", true) => (MOUSEEVENTF_RIGHTDOWN, 0u32),
        ("right", false) => (MOUSEEVENTF_RIGHTUP, 0u32),
        ("middle", true) => (MOUSEEVENTF_MIDDLEDOWN, 0u32),
        ("middle", false) => (MOUSEEVENTF_MIDDLEUP, 0u32),
        ("back" | "x1", true) => (MOUSEEVENTF_XDOWN, 0x0001u32),
        ("back" | "x1", false) => (MOUSEEVENTF_XUP, 0x0001u32),
        ("forward" | "x2", true) => (MOUSEEVENTF_XDOWN, 0x0002u32),
        ("forward" | "x2", false) => (MOUSEEVENTF_XUP, 0x0002u32),
        _ => return None,
    };
    let (dx, dy) = if let Some((ax, ay)) = abs_pos {
        flags |= MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        (ax, ay)
    } else {
        (0, 0)
    };
    Some(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: mouse_data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: P2SHARER_INPUT_TAG,
            },
        },
    })
}

#[cfg(windows)]
fn is_extended_vk(vk: u16) -> bool {
    matches!(
        vk,
        0x21..=0x28 // PageUp, PageDown, End, Home, Arrows
            | 0x2C // PrintScreen
            | 0x2D // Insert
            | 0x2E // Delete
            | 0x5B // LWin
            | 0x5C // RWin
            | 0x5D // Apps
            | 0x6F // NumpadDivide
            | 0x90 // NumLock
            | 0xA3 // RControl
            | 0xA5 // RMenu (AltGr)
    )
}

#[cfg(windows)]
fn make_vk_input(
    vk: u16,
    down: bool,
    extended_override: Option<bool>,
) -> windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MAPVK_VK_TO_VSC, VIRTUAL_KEY,
    };
    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
    let mut flags = windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0);
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    if extended_override.unwrap_or_else(|| is_extended_vk(vk)) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    // Pause/Break and Win keys work reliably with wVk directly; scan code accompanies it.
    let _ = KEYEVENTF_SCANCODE;
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: P2SHARER_INPUT_TAG,
            },
        },
    }
}

#[cfg(windows)]
fn make_unicode_inputs(
    text: &str,
    down: bool,
) -> Vec<windows::Win32::UI::Input::KeyboardAndMouse::INPUT> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        VIRTUAL_KEY,
    };
    let flags = if down {
        KEYEVENTF_UNICODE
    } else {
        KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
    };
    text.encode_utf16()
        .map(|unit| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: unit,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: P2SHARER_INPUT_TAG,
                },
            },
        })
        .collect()
}

#[cfg(windows)]
fn make_unicode_units_inputs(
    units: &[u16],
    down: bool,
) -> Vec<windows::Win32::UI::Input::KeyboardAndMouse::INPUT> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        VIRTUAL_KEY,
    };
    let flags = if down {
        KEYEVENTF_UNICODE
    } else {
        KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
    };
    units
        .iter()
        .map(|&unit| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: unit,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: P2SHARER_INPUT_TAG,
                },
            },
        })
        .collect()
}

fn dom_code_to_vk(code: &str) -> Option<(u16, bool)> {
    if let Some(letter) = code.strip_prefix("Key") {
        let bytes = letter.as_bytes();
        if bytes.len() == 1 && bytes[0].is_ascii_uppercase() {
            return Some((bytes[0] as u16, false));
        }
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        let bytes = digit.as_bytes();
        if bytes.len() == 1 && bytes[0].is_ascii_digit() {
            return Some((bytes[0] as u16, false));
        }
    }
    if let Some(fnum) = code.strip_prefix('F') {
        if let Ok(n) = fnum.parse::<u16>() {
            if (1..=24).contains(&n) {
                return Some((0x70 + (n - 1), false));
            }
        }
    }
    if let Some(num) = code.strip_prefix("Numpad") {
        if num.len() == 1 && num.as_bytes()[0].is_ascii_digit() {
            return Some((0x60 + (num.as_bytes()[0] - b'0') as u16, false));
        }
    }
    Some(match code {
        "Backspace" => (0x08, false),
        "Tab" => (0x09, false),
        "Enter" => (0x0D, false),
        "NumpadEnter" => (0x0D, true),
        "ShiftLeft" => (0xA0, false),
        "ShiftRight" => (0xA1, false),
        "ControlLeft" => (0xA2, false),
        "ControlRight" => (0xA3, true),
        "AltLeft" => (0xA4, false),
        "AltRight" => (0xA5, true),
        "Pause" => (0x13, false),
        "CapsLock" => (0x14, false),
        "Escape" => (0x1B, false),
        "Space" => (0x20, false),
        "PageUp" => (0x21, true),
        "PageDown" => (0x22, true),
        "End" => (0x23, true),
        "Home" => (0x24, true),
        "ArrowLeft" => (0x25, true),
        "ArrowUp" => (0x26, true),
        "ArrowRight" => (0x27, true),
        "ArrowDown" => (0x28, true),
        "PrintScreen" => (0x2C, true),
        "Insert" => (0x2D, true),
        "Delete" => (0x2E, true),
        "MetaLeft" | "OSLeft" => (0x5B, true),
        "MetaRight" | "OSRight" => (0x5C, true),
        "ContextMenu" => (0x5D, true),
        "NumpadMultiply" => (0x6A, false),
        "NumpadAdd" => (0x6B, false),
        "NumpadSubtract" => (0x6D, false),
        "NumpadDecimal" => (0x6E, false),
        "NumpadDivide" => (0x6F, true),
        "NumLock" => (0x90, true),
        "ScrollLock" => (0x91, false),
        "Semicolon" => (0xBA, false),
        "Equal" => (0xBB, false),
        "Comma" => (0xBC, false),
        "Minus" => (0xBD, false),
        "Period" => (0xBE, false),
        "Slash" => (0xBF, false),
        "Backquote" => (0xC0, false),
        "IntlRo" => (0xC1, false),
        "BracketLeft" => (0xDB, false),
        "Backslash" => (0xDC, false),
        "BracketRight" => (0xDD, false),
        "Quote" => (0xDE, false),
        "IntlBackslash" => (0xE2, false),
        _ => return None,
    })
}

fn vk_to_dom_code(vk: u16) -> (&'static str, &'static str) {
    match vk {
        0x5B => ("MetaLeft", "Meta"),
        0x5C => ("MetaRight", "Meta"),
        0x5D => ("ContextMenu", "ContextMenu"),
        0x2C => ("PrintScreen", "PrintScreen"),
        0x09 => ("Tab", "Tab"),
        0x1B => ("Escape", "Escape"),
        0x73 => ("F4", "F4"),
        0x20 => ("Space", " "),
        _ => ("", ""),
    }
}

fn is_punctuation_code(code: &str) -> bool {
    matches!(
        code,
        "Semicolon"
            | "Equal"
            | "Comma"
            | "Minus"
            | "Period"
            | "Slash"
            | "Backquote"
            | "BracketLeft"
            | "Backslash"
            | "BracketRight"
            | "Quote"
            | "IntlBackslash"
            | "IntlRo"
    )
}

#[cfg(windows)]
fn normalized_to_virtual_desktop_cached(
    state: &mut HostControlState,
    session_id: Option<&str>,
    x: f64,
    y: f64,
) -> Option<(i32, i32)> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };
    if !x.is_finite() || !y.is_finite() || !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y)
    {
        return None;
    }
    let sid = session_id?;
    let now = now_ms();
    let needs_refresh = match state.mapping_cache.as_ref() {
        Some(cached) if cached.session_id == sid => {
            let ttl_ms = if cached.is_window { 120 } else { 500 };
            now.saturating_sub(cached.refreshed_at_ms) >= ttl_ms
        }
        _ => true,
    };
    if needs_refresh {
        let source = crate::screen_sources::pointer_capture_source(sid)?;
        let source_bounds = crate::stream_pointer::source_bounds(&source)?;
        let virtual_bounds = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2),
                GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2),
            )
        };
        state.mapping_cache = Some(CachedDesktopMapping {
            session_id: sid.to_string(),
            is_window: source.starts_with("window:"),
            source_bounds,
            virtual_bounds,
            refreshed_at_ms: now,
        });
    }
    let cached = state.mapping_cache.as_ref()?;
    let (left, top, width, height) = cached.source_bounds;
    let (vx, vy, vw, vh) = cached.virtual_bounds;
    let px = left
        + ((x * (width.saturating_sub(1) as f64)).round() as i32)
            .clamp(0, width.saturating_sub(1) as i32);
    let py = top
        + ((y * (height.saturating_sub(1) as f64)).round() as i32)
            .clamp(0, height.saturating_sub(1) as i32);
    let abs_x = (((px - vx) as i64 * 65535 + ((vw - 1) as i64 / 2)) / (vw - 1) as i64)
        .clamp(0, 65535) as i32;
    let abs_y = (((py - vy) as i64 * 65535 + ((vh - 1) as i64 / 2)) / (vh - 1) as i64)
        .clamp(0, 65535) as i32;
    Some((abs_x, abs_y))
}

#[cfg(windows)]
fn release_controller_locked(state: &mut HostControlState, controller_id: &str) {
    let mut inputs = Vec::new();
    if let Some(buttons) = state.held_buttons.remove(controller_id) {
        for btn in buttons {
            if let Some(input) = make_mouse_button_input(&btn, false, None) {
                inputs.push(input);
            }
        }
    }
    if let Some(vks) = state.held_vks.remove(controller_id) {
        for vk in vks {
            inputs.push(make_vk_input(vk, false, None));
        }
    }
    let unicode_keys: Vec<(String, String)> = state
        .held_unicode
        .keys()
        .filter(|(cid, _)| cid == controller_id)
        .cloned()
        .collect();
    for key in unicode_keys {
        if let Some(units) = state.held_unicode.remove(&key) {
            inputs.extend(make_unicode_units_inputs(&units, false));
        }
    }
    if !inputs.is_empty() {
        send_win32_inputs(&inputs);
        state.last_self_input_tick = read_last_input_tick();
    }
}

#[cfg(windows)]
fn release_all_locked(state: &mut HostControlState) {
    let ids: Vec<String> = state
        .held_buttons
        .keys()
        .chain(state.held_vks.keys())
        .chain(state.held_unicode.keys().map(|(cid, _)| cid))
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    for id in ids {
        release_controller_locked(state, &id);
    }
}

#[cfg(windows)]
fn is_window_or_descendant_foreground(target: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetForegroundWindow, IsChild, GA_ROOT, GA_ROOTOWNER,
    };
    if target.0.is_null() {
        return false;
    }
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return false;
        }
        fg == target
            || IsChild(target, fg).as_bool()
            || GetAncestor(fg, GA_ROOTOWNER) == target
            || GetAncestor(fg, GA_ROOT) == target
    }
}

#[cfg(windows)]
unsafe extern "system" fn host_priority_mouse_proc(
    code: i32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, MSLLHOOKSTRUCT, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_MOUSEHWHEEL,
        WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_XBUTTONDOWN,
    };
    if code >= 0 && HOST_ACTIVE.load(Ordering::Relaxed) {
        let ms = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        // Ignore software/SendInput events (LLMHF_INJECTED = 0x01, LLMHF_LOWER_IL_INJECTED = 0x02)
        // and any events carrying our explicit SendInput tag.
        if (ms.flags & 0x03) == 0 && ms.dwExtraInfo != P2SHARER_INPUT_TAG {
            let msg = wparam.0 as u32;
            let triggered = if msg == WM_MOUSEMOVE {
                if let Ok(mut guard) = HOST_LAST_HW_CURSOR.try_lock() {
                    let os_cur = read_cursor_pos();
                    let next_pt = (ms.pt.x, ms.pt.y);
                    let (mut anchor, prev_hw) = guard.unwrap_or_else(|| {
                        let base = os_cur.unwrap_or(next_pt);
                        (base, base)
                    });
                    // Reset anchor when injected controller SendInput moved the OS cursor between physical packets.
                    let moved_externally = os_cur
                        .map(|(cx, cy)| (cx - prev_hw.0).abs() > 1 || (cy - prev_hw.1).abs() > 1)
                        .unwrap_or(false);
                    let cur_base = if moved_externally {
                        let base = os_cur.unwrap_or(next_pt);
                        anchor = base;
                        base
                    } else {
                        os_cur.unwrap_or(prev_hw)
                    };
                    *guard = Some((anchor, next_pt));
                    (ms.pt.x - cur_base.0).abs() > HOST_MOUSE_JITTER_PX
                        || (ms.pt.y - cur_base.1).abs() > HOST_MOUSE_JITTER_PX
                        || (ms.pt.x - anchor.0).abs() > HOST_MOUSE_JITTER_PX
                        || (ms.pt.y - anchor.1).abs() > HOST_MOUSE_JITTER_PX
                } else {
                    false
                }
            } else {
                matches!(
                    msg,
                    WM_LBUTTONDOWN
                        | WM_RBUTTONDOWN
                        | WM_MBUTTONDOWN
                        | WM_XBUTTONDOWN
                        | WM_MOUSEWHEEL
                        | WM_MOUSEHWHEEL
                )
            };
            if triggered {
                HOST_HARDWARE_INPUT_MS.store(now_ms(), Ordering::Release);
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

#[cfg(windows)]
unsafe extern "system" fn host_priority_keyboard_proc(
    code: i32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, KBDLLHOOKSTRUCT, LLKHF_INJECTED, WM_KEYDOWN, WM_SYSKEYDOWN,
    };
    if code >= 0 && HOST_ACTIVE.load(Ordering::Relaxed) {
        let msg = wparam.0 as u32;
        if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            if (kb.flags.0 & (LLKHF_INJECTED.0 | 0x02)) == 0
                && kb.dwExtraInfo != P2SHARER_INPUT_TAG
            {
                HOST_HARDWARE_INPUT_MS.store(now_ms(), Ordering::Release);
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

#[cfg(windows)]
fn start_host_priority_hooks() {
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, PeekMessageW, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, MSG, PM_NOREMOVE, WH_KEYBOARD_LL, WH_MOUSE_LL,
    };
    let Ok(mut guard) = HOST_PRIORITY_HOOK_JOIN.lock() else {
        return;
    };
    if guard.is_some() {
        return;
    }
    if let Ok(mut pos) = HOST_LAST_HW_CURSOR.lock() {
        *pos = read_cursor_pos().map(|p| (p, p));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<(u32, bool)>(1);
    let join = std::thread::spawn(move || unsafe {
        let tid = GetCurrentThreadId();
        let mut msg = MSG::default();
        // Force creation of the Win32 thread message queue before signaling readiness.
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(host_priority_mouse_proc), None, 0);
        let kb_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(host_priority_keyboard_proc), None, 0);
        let ok = mouse_hook.is_ok() && kb_hook.is_ok();
        let stay_alive = ok && !thread_stop.load(Ordering::Acquire);
        HOST_PRIORITY_HOOK_ACTIVE.store(stay_alive, Ordering::Release);
        let _ = ready_tx.send((tid, stay_alive));
        if stay_alive {
            while !thread_stop.load(Ordering::Acquire) && GetMessageW(&mut msg, None, 0, 0).as_bool()
            {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        HOST_PRIORITY_HOOK_ACTIVE.store(false, Ordering::Release);
        if let Ok(h) = mouse_hook {
            let _ = UnhookWindowsHookEx(h);
        }
        if let Ok(h) = kb_hook {
            let _ = UnhookWindowsHookEx(h);
        }
    });
    if let Ok((tid, ok)) = ready_rx.recv() {
        crate::logger::log_msg(
            if ok { "INFO" } else { "WARN" },
            "remote_control",
            &format!("host hardware priority hooks active={}", ok),
        );
        *guard = Some(HookThreadHandle {
            thread_id: tid,
            stop,
            join,
        });
    } else {
        stop.store(true, Ordering::Release);
        drop(join);
    }
}

#[cfg(windows)]
fn stop_host_priority_hooks() {
    HOST_PRIORITY_HOOK_ACTIVE.store(false, Ordering::Release);
    if let Ok(mut guard) = HOST_PRIORITY_HOOK_JOIN.lock() {
        if let Some(handle) = guard.take() {
            join_hook_thread(handle);
        }
    }
}

#[cfg(windows)]
fn poll_host_activity_locked(state: &mut HostControlState) -> bool {
    let now = now_ms();
    let mut host_touched = false;

    if HOST_PRIORITY_HOOK_ACTIVE.load(Ordering::Acquire) {
        let hw_ms = HOST_HARDWARE_INPUT_MS.load(Ordering::Acquire);
        if hw_ms > state.last_hw_input_ms {
            state.last_hw_input_ms = hw_ms;
            // Anchor pause window to actual hardware timestamp while preventing stale timestamps from re-pausing later.
            let expires = hw_ms.saturating_add(HOST_PRIORITY_MS);
            if expires > now {
                state.host_paused_until = state.host_paused_until.max(expires);
                host_touched = true;
            }
        }
    } else {
        // Fallback when LL hooks cannot be installed.
        let lii_tick = read_last_input_tick();
        if state.last_self_input_tick != 0 && lii_tick != state.last_self_input_tick {
            state.last_self_input_tick = lii_tick;
            host_touched = true;
        } else if state.last_self_input_tick == 0 {
            state.last_self_input_tick = lii_tick;
        }

        if let Some((cx, cy)) = read_cursor_pos() {
            if let Some((lx, ly)) = state.last_self_cursor {
                if (cx - lx).abs() > HOST_MOUSE_JITTER_PX || (cy - ly).abs() > HOST_MOUSE_JITTER_PX
                {
                    state.last_self_cursor = Some((cx, cy));
                    host_touched = true;
                }
            } else {
                state.last_self_cursor = Some((cx, cy));
            }
        }

        if host_touched {
            state.host_paused_until = now + HOST_PRIORITY_MS;
        }
    }

    if host_touched {
        state.last_mouse_actor_id = Some("host".to_string());
        release_all_locked(state);
        if !HOST_PRIORITY_HOOK_ACTIVE.load(Ordering::Acquire) {
            if let Some(pos) = read_cursor_pos() {
                state.last_self_cursor = Some(pos);
            }
            state.last_self_input_tick = read_last_input_tick();
        }
    }

    let paused = now < state.host_paused_until;
    if state.was_host_paused && !paused && !HOST_PRIORITY_HOOK_ACTIVE.load(Ordering::Acquire) {
        state.last_self_input_tick = read_last_input_tick();
        state.last_self_cursor = read_cursor_pos();
    }
    state.was_host_paused = paused;
    paused
}

#[cfg(windows)]
fn sample_cursor_sync(
    preferred_session_id: Option<&str>,
    host_busy: bool,
    cursor_shape: &str,
    actor_controller_id: Option<&str>,
) -> Option<CursorSyncPayload> {
    let (session_id, source, embedded_in_video) =
        crate::screen_sources::active_cursor_session_info(preferred_session_id)?;
    let (left, top, width, height) = crate::stream_pointer::source_bounds(&source)?;
    let (px, py) = read_cursor_pos()?;
    let visible = width > 1
        && height > 1
        && px >= left
        && px < left + width as i32
        && py >= top
        && py < top + height as i32;
    let x = ((px - left) as f64 / (width.saturating_sub(1).max(1) as f64)).clamp(0.0, 1.0);
    let y = ((py - top) as f64 / (height.saturating_sub(1).max(1) as f64)).clamp(0.0, 1.0);
    let actor = if host_busy {
        "host".to_string()
    } else {
        actor_controller_id.unwrap_or("host").to_string()
    };
    Some(CursorSyncPayload {
        session_id,
        active: true,
        visible,
        x,
        y,
        cursor_shape: cursor_shape.to_string(),
        host_busy,
        actor_controller_id: actor,
        embedded_in_video,
    })
}

fn emit_inactive_cursor_sync(app: &AppHandle) {
    let _ = app.emit_to(
        "main",
        "remote-control-cursor-sync",
        CursorSyncPayload {
            session_id: String::new(),
            active: false,
            visible: false,
            x: 0.0,
            y: 0.0,
            cursor_shape: "default".to_string(),
            host_busy: false,
            actor_controller_id: String::new(),
            embedded_in_video: true,
        },
    );
}

#[tauri::command]
pub fn set_remote_control_active(
    app: AppHandle,
    window: tauri::WebviewWindow,
    active: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can manage host remote control".into());
    }
    HOST_ACTIVE.store(active, Ordering::Release);
    crate::screen_sources::refresh_wgc_cursor_for_remote_control();
    #[cfg(windows)]
    {
        if active {
            HOST_HARDWARE_INPUT_MS.store(0, Ordering::Release);
            start_host_priority_hooks();
        } else {
            stop_host_priority_hooks();
        }
        let mut should_spawn = false;
        {
            let mut state = HOST_STATE.lock().map_err(|_| "Remote control lock poisoned")?;
            state.active = active;
            if active {
                state.last_self_input_tick = read_last_input_tick();
                state.last_self_cursor = read_cursor_pos();
                state.last_hw_input_ms = 0;
                state.host_paused_until = 0;
                state.was_host_paused = false;
                state.last_cursor_shape = read_cursor_shape();
                if !state.monitor_running {
                    state.monitor_running = true;
                    should_spawn = true;
                }
            } else {
                release_all_locked(&mut state);
                state.host_paused_until = 0;
                state.was_host_paused = false;
                state.last_session_id = None;
                state.last_mouse_actor_id = None;
                state.mapping_cache = None;
            }
        }
        if !active {
            emit_inactive_cursor_sync(&app);
        }
        if should_spawn {
            std::thread::spawn(move || {
                let mut prev_paused = false;
                let mut prev_shape = String::new();
                let mut prev_cursor_sync: Option<CursorSyncPayload> = None;
                let mut last_cursor_emit_ms: u64 = 0;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(MONITOR_INTERVAL_MS));
                    let (still_active, paused, shape, preferred_sid, actor) = {
                        let Ok(mut state) = HOST_STATE.lock() else {
                            break;
                        };
                        if !state.active {
                            state.monitor_running = false;
                            break;
                        }
                        let paused = poll_host_activity_locked(&mut state);
                        let shape = read_cursor_shape();
                        state.last_cursor_shape = shape.clone();
                        (
                            true,
                            paused,
                            shape,
                            state.last_session_id.clone(),
                            state.last_mouse_actor_id.clone(),
                        )
                    };
                    if !still_active {
                        break;
                    }
                    if paused != prev_paused || shape != prev_shape {
                        prev_paused = paused;
                        prev_shape = shape.clone();
                        let _ = app.emit_to(
                            "main",
                            "remote-control-host-priority",
                            HostPriorityPayload {
                                host_busy: paused,
                                cursor_shape: shape.clone(),
                            },
                        );
                    }
                    if let Some(sync_payload) = sample_cursor_sync(
                        preferred_sid.as_deref(),
                        paused,
                        &shape,
                        actor.as_deref(),
                    ) {
                        let now = now_ms();
                        let changed = prev_cursor_sync.as_ref() != Some(&sync_payload);
                        if changed || now.saturating_sub(last_cursor_emit_ms) >= 450 {
                            prev_cursor_sync = Some(sync_payload.clone());
                            last_cursor_emit_ms = now;
                            let _ = app.emit_to(
                                "main",
                                "remote-control-cursor-sync",
                                sync_payload,
                            );
                        }
                    }
                }
                emit_inactive_cursor_sync(&app);
            });
        }
    }
    #[cfg(not(windows))]
    let _ = (app, active);
    Ok(())
}

#[tauri::command]
pub fn apply_remote_control_input(
    window: tauri::WebviewWindow,
    controller_id: String,
    session_id: Option<String>,
    event: RemoteInputEvent,
) -> Result<ApplyInputResult, String> {
    if window.label() != "main" {
        return Err("Only the main window can apply remote control input".into());
    }
    if controller_id.is_empty() || controller_id.len() > 240 {
        return Err("Invalid controller ID".into());
    }
    #[cfg(windows)]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL,
            MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT,
        };
        let input_started = std::time::Instant::now();
        let mut state = HOST_STATE.lock().map_err(|_| "Remote control lock poisoned")?;
        if !state.active {
            return Ok(ApplyInputResult {
                accepted: false,
                host_busy: false,
            });
        }
        if matches!(event, RemoteInputEvent::ReleaseAll) {
            release_controller_locked(&mut state, &controller_id);
            return Ok(ApplyInputResult {
                accepted: true,
                host_busy: state.was_host_paused,
            });
        }
        if poll_host_activity_locked(&mut state) {
            state.perf_busy_dropped += 1;
            return Ok(ApplyInputResult {
                accepted: false,
                host_busy: true,
            });
        }

        if let Some(sid) = session_id.as_ref() {
            state.last_session_id = Some(sid.clone());
        }
        let is_mouse_event = matches!(
            event,
            RemoteInputEvent::MouseMove { .. }
                | RemoteInputEvent::MouseButton { .. }
                | RemoteInputEvent::MouseWheel { .. }
        );
        if is_mouse_event {
            state.last_mouse_actor_id = Some(controller_id.clone());
        }
        let mut moved_cursor = false;
        match event {
            RemoteInputEvent::MouseMove { x, y } => {
                let Some((dx, dy)) =
                    normalized_to_virtual_desktop_cached(&mut state, session_id.as_deref(), x, y)
                else {
                    return Ok(ApplyInputResult {
                        accepted: false,
                        host_busy: false,
                    });
                };
                let input = INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dx,
                            dy,
                            mouseData: 0,
                            dwFlags: MOUSEEVENTF_MOVE
                                | MOUSEEVENTF_ABSOLUTE
                                | MOUSEEVENTF_VIRTUALDESK,
                            time: 0,
                            dwExtraInfo: P2SHARER_INPUT_TAG,
                        },
                    },
                };
                send_win32_inputs(&[input]);
                moved_cursor = true;
            }
            RemoteInputEvent::MouseButton {
                button,
                down,
                x,
                y,
            } => {
                let abs = match (x, y) {
                    (Some(nx), Some(ny)) => {
                        let res = normalized_to_virtual_desktop_cached(
                            &mut state,
                            session_id.as_deref(),
                            nx,
                            ny,
                        );
                        if res.is_some() {
                            moved_cursor = true;
                        }
                        res
                    }
                    _ => None,
                };
                if let Some(input) = make_mouse_button_input(&button, down, abs) {
                    if down {
                        state
                            .held_buttons
                            .entry(controller_id.clone())
                            .or_default()
                            .insert(button);
                    } else if let Some(set) = state.held_buttons.get_mut(&controller_id) {
                        set.remove(&button);
                    }
                    send_win32_inputs(&[input]);
                }
            }
            RemoteInputEvent::MouseWheel {
                delta_x,
                delta_y,
                x,
                y,
            } => {
                if !delta_x.is_finite() || !delta_y.is_finite() {
                    return Ok(ApplyInputResult {
                        accepted: false,
                        host_busy: false,
                    });
                }
                let mut inputs = Vec::new();
                if let (Some(nx), Some(ny)) = (x, y) {
                    if let Some((dx, dy)) = normalized_to_virtual_desktop_cached(
                        &mut state,
                        session_id.as_deref(),
                        nx,
                        ny,
                    ) {
                        moved_cursor = true;
                        inputs.push(INPUT {
                            r#type: INPUT_MOUSE,
                            Anonymous: INPUT_0 {
                                mi: MOUSEINPUT {
                                    dx,
                                    dy,
                                    mouseData: 0,
                                    dwFlags: MOUSEEVENTF_MOVE
                                        | MOUSEEVENTF_ABSOLUTE
                                        | MOUSEEVENTF_VIRTUALDESK,
                                    time: 0,
                                    dwExtraInfo: P2SHARER_INPUT_TAG,
                                },
                            },
                        });
                    }
                }
                let wheel_y = (-delta_y.clamp(-1200.0, 1200.0) * 1.2).round() as i32;
                if wheel_y != 0 {
                    inputs.push(INPUT {
                        r#type: INPUT_MOUSE,
                        Anonymous: INPUT_0 {
                            mi: MOUSEINPUT {
                                dx: 0,
                                dy: 0,
                                mouseData: wheel_y as u32,
                                dwFlags: MOUSEEVENTF_WHEEL,
                                time: 0,
                                dwExtraInfo: P2SHARER_INPUT_TAG,
                            },
                        },
                    });
                }
                let wheel_x = (delta_x.clamp(-1200.0, 1200.0) * 1.2).round() as i32;
                if wheel_x != 0 {
                    inputs.push(INPUT {
                        r#type: INPUT_MOUSE,
                        Anonymous: INPUT_0 {
                            mi: MOUSEINPUT {
                                dx: 0,
                                dy: 0,
                                mouseData: wheel_x as u32,
                                dwFlags: MOUSEEVENTF_HWHEEL,
                                time: 0,
                                dwExtraInfo: P2SHARER_INPUT_TAG,
                            },
                        },
                    });
                }
                send_win32_inputs(&inputs);
            }
            RemoteInputEvent::Key {
                code,
                key,
                down,
                repeat: _,
                vk,
                ctrl_key,
                alt_key,
                meta_key,
            } => {
                if code.len() > 64 || key.len() > 32 {
                    return Ok(ApplyInputResult {
                        accepted: false,
                        host_busy: false,
                    });
                }
                let modifiers_held =
                    ctrl_key.unwrap_or(false) || alt_key.unwrap_or(false) || meta_key.unwrap_or(false);
                if !down {
                    if let Some(units) = state
                        .held_unicode
                        .remove(&(controller_id.clone(), code.clone()))
                    {
                        let inputs = make_unicode_units_inputs(&units, false);
                        send_win32_inputs(&inputs);
                        state.last_self_input_tick = read_last_input_tick();
                        return Ok(ApplyInputResult {
                            accepted: true,
                            host_busy: false,
                        });
                    }
                }
                let char_count = key.chars().count();
                let is_non_ascii_printable =
                    char_count == 1 && !key.is_ascii() && key != "Dead";
                let use_unicode = !modifiers_held
                    && key != "Dead"
                    && char_count == 1
                    && (is_non_ascii_printable || is_punctuation_code(&code) || dom_code_to_vk(&code).is_none());
                if use_unicode {
                    let units: Vec<u16> = key.encode_utf16().collect();
                    if down {
                        state
                            .held_unicode
                            .insert((controller_id.clone(), code.clone()), units.clone());
                    }
                    let inputs = make_unicode_inputs(&key, down);
                    send_win32_inputs(&inputs);
                } else if let Some((resolved_vk, ext)) = vk
                    .filter(|&v| v > 0 && v <= 0xFE)
                    .map(|v| (v, is_extended_vk(v)))
                    .or_else(|| dom_code_to_vk(&code))
                {
                    if down {
                        state
                            .held_vks
                            .entry(controller_id.clone())
                            .or_default()
                            .insert(resolved_vk);
                    } else if let Some(set) = state.held_vks.get_mut(&controller_id) {
                        set.remove(&resolved_vk);
                    }
                    let input = make_vk_input(resolved_vk, down, Some(ext));
                    send_win32_inputs(&[input]);
                }
            }
            RemoteInputEvent::ReleaseAll => {}
        }

        if !HOST_PRIORITY_HOOK_ACTIVE.load(Ordering::Acquire) {
            state.last_self_input_tick = read_last_input_tick();
            if moved_cursor {
                if let Some(pos) = read_cursor_pos() {
                    state.last_self_cursor = Some(pos);
                }
            }
        } else {
            let _ = moved_cursor;
        }
        let elapsed_us = input_started.elapsed().as_micros() as u64;
        state.perf_applied += 1;
        state.perf_total_us += elapsed_us;
        state.perf_max_us = state.perf_max_us.max(elapsed_us);
        if state.perf_applied >= 250 {
            let now = now_ms();
            if now.saturating_sub(state.perf_last_log_ms) >= 5000 {
                let avg_us = state.perf_total_us / state.perf_applied.max(1);
                crate::logger::log_msg(
                    "INFO",
                    "remote_control.perf",
                    &format!(
                        "host_apply count={} busy_dropped={} avg_us={} max_us={}",
                        state.perf_applied,
                        state.perf_busy_dropped,
                        avg_us,
                        state.perf_max_us
                    ),
                );
                state.perf_applied = 0;
                state.perf_busy_dropped = 0;
                state.perf_total_us = 0;
                state.perf_max_us = 0;
                state.perf_last_log_ms = now;
            }
        }

        Ok(ApplyInputResult {
            accepted: true,
            host_busy: false,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (controller_id, session_id, event);
        Ok(ApplyInputResult {
            accepted: false,
            host_busy: false,
        })
    }
}

#[tauri::command]
pub fn release_remote_control_inputs(
    window: tauri::WebviewWindow,
    controller_id: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can release remote control inputs".into());
    }
    #[cfg(windows)]
    {
        let mut state = HOST_STATE.lock().map_err(|_| "Remote control lock poisoned")?;
        if let Some(id) = controller_id {
            release_controller_locked(&mut state, &id);
        } else {
            release_all_locked(&mut state);
        }
    }
    #[cfg(not(windows))]
    let _ = controller_id;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorClipRectPayload {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg(windows)]
fn immersive_hold_bit(vk: u16) -> u32 {
    match vk {
        0x09 => 1 << 0, // VK_TAB
        0x73 => 1 << 1, // VK_F4
        0x20 => 1 << 2, // VK_SPACE
        0x1B => 1 << 3, // VK_ESCAPE
        _ => 0,
    }
}

#[cfg(windows)]
unsafe extern "system" fn immersive_keyboard_proc(
    code: i32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::{HWND, LRESULT};
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, KBDLLHOOKSTRUCT, LLKHF_ALTDOWN, LLKHF_INJECTED, WM_KEYDOWN, WM_KEYUP,
        WM_SYSKEYDOWN, WM_SYSKEYUP,
    };
    if code >= 0 && IMMERSIVE_ENABLED.load(Ordering::Acquire) {
        let target = HWND(IMMERSIVE_TARGET_HWND.load(Ordering::Acquire) as *mut _);
        if is_window_or_descendant_foreground(target) {
            let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            if (kb.flags.0 & (LLKHF_INJECTED.0 | 0x02)) == 0
                && kb.dwExtraInfo != P2SHARER_INPUT_TAG
            {
                let vk = kb.vkCode as u16;
                let alt_down = (kb.flags.0 & LLKHF_ALTDOWN.0) != 0
                    || (GetAsyncKeyState(0x12) < 0)
                    || (GetAsyncKeyState(0xA4) < 0)
                    || (GetAsyncKeyState(0xA5) < 0);
                let ctrl_down = (GetAsyncKeyState(0x11) < 0)
                    || (GetAsyncKeyState(0xA2) < 0)
                    || (GetAsyncKeyState(0xA3) < 0);
                let msg = wparam.0 as u32;
                let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
                let hold_bit = immersive_hold_bit(vk);
                let was_held_intercepted =
                    hold_bit != 0 && (IMMERSIVE_HELD_MASK.load(Ordering::Acquire) & hold_bit) != 0;

                let intercept_shortcut = matches!(vk, 0x5B | 0x5C | 0x5D | 0x2C | 0x1B)
                    || (alt_down && matches!(vk, 0x09 | 0x73 | 0x20 | 0x1B))
                    || (ctrl_down && vk == 0x1B)
                    || (is_up && was_held_intercepted);

                if intercept_shortcut && (down || is_up) {
                    if hold_bit != 0 {
                        if down {
                            IMMERSIVE_HELD_MASK.fetch_or(hold_bit, Ordering::AcqRel);
                        } else if is_up {
                            IMMERSIVE_HELD_MASK.fetch_and(!hold_bit, Ordering::AcqRel);
                        }
                    }
                    let (dom_code, dom_key) = vk_to_dom_code(vk);
                    if let Ok(guard) = IMMERSIVE_TX.try_lock() {
                        if let Some(tx) = guard.as_ref() {
                            let _ = tx.try_send(ImmersiveKeyPayload {
                                vk,
                                code: dom_code.to_string(),
                                key: dom_key.to_string(),
                                down,
                            });
                        }
                    }
                    return LRESULT(1);
                }
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

#[cfg(windows)]
fn join_immersive_hook_locked(guard: &mut Option<HookThreadHandle>) {
    IMMERSIVE_ENABLED.store(false, Ordering::Release);
    IMMERSIVE_HELD_MASK.store(0, Ordering::Release);
    if let Ok(mut tx_guard) = IMMERSIVE_TX.lock() {
        *tx_guard = None;
    }
    if let Some(handle) = guard.take() {
        join_hook_thread(handle);
    }
}

#[tauri::command]
pub fn set_remote_control_immersive(
    app: AppHandle,
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<(), String> {
    let label = window.label().to_string();
    if label != "main" && !label.starts_with("pip-") {
        return Err("Only application stream windows can enable immersive mode".into());
    }
    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::GetCurrentThreadId;
        use windows::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, PeekMessageW, SetWindowsHookExW, TranslateMessage,
            UnhookWindowsHookEx, MSG, PM_NOREMOVE, WH_KEYBOARD_LL,
        };
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        IMMERSIVE_TARGET_HWND.store(hwnd, Ordering::Release);
        *IMMERSIVE_TARGET_LABEL
            .lock()
            .map_err(|_| "Immersive label lock poisoned")? = label.clone();

        let mut hook_guard = IMMERSIVE_HOOK_JOIN
            .lock()
            .map_err(|_| "Immersive lifecycle lock poisoned")?;

        if enabled {
            if hook_guard.is_some() {
                IMMERSIVE_ENABLED.store(true, Ordering::Release);
                return Ok(());
            }

            let (tx, rx) = std::sync::mpsc::sync_channel::<ImmersiveKeyPayload>(128);
            *IMMERSIVE_TX
                .lock()
                .map_err(|_| "Immersive sender lock poisoned")? = Some(tx);

            let emitter_app = app.clone();
            std::thread::spawn(move || {
                while let Ok(payload) = rx.recv() {
                    if let Ok(target_label) = IMMERSIVE_TARGET_LABEL.lock() {
                        let _ = emitter_app.emit_to(
                            target_label.as_str(),
                            "remote-control-immersive-key",
                            payload,
                        );
                    }
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
                    Some(immersive_keyboard_proc),
                    None,
                    0,
                );
                let stay_alive = hook.is_ok() && !thread_stop.load(Ordering::Acquire);
                let _ = ready_tx.send((tid, stay_alive));
                if let Ok(h) = hook {
                    if stay_alive {
                        while !thread_stop.load(Ordering::Acquire)
                            && GetMessageW(&mut msg, None, 0, 0).as_bool()
                        {
                            let _ = TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        }
                    }
                    let _ = UnhookWindowsHookEx(h);
                }
                if let Ok(mut tx_guard) = IMMERSIVE_TX.lock() {
                    *tx_guard = None;
                }
            });

            if let Ok((tid, ok)) = ready_rx.recv() {
                crate::logger::log_msg(
                    if ok { "INFO" } else { "WARN" },
                    "remote_control",
                    &format!("immersive keyboard hook active={} window={}", ok, label),
                );
                *hook_guard = Some(HookThreadHandle {
                    thread_id: tid,
                    stop,
                    join,
                });
                IMMERSIVE_HELD_MASK.store(0, Ordering::Release);
                IMMERSIVE_ENABLED.store(ok, Ordering::Release);
            } else {
                stop.store(true, Ordering::Release);
                drop(join);
                IMMERSIVE_ENABLED.store(false, Ordering::Release);
            }
        } else {
            join_immersive_hook_locked(&mut hook_guard);
        }
    }
    #[cfg(not(windows))]
    let _ = (app, enabled);
    Ok(())
}

#[cfg(windows)]
fn release_cursor_clip_win32() {
    use windows::Win32::UI::WindowsAndMessaging::ClipCursor;
    if CURSOR_CLIP_ACTIVE.swap(false, Ordering::AcqRel) {
        unsafe {
            let _ = ClipCursor(None);
        }
    }
}

#[tauri::command]
pub fn set_remote_control_cursor_clip(
    window: tauri::WebviewWindow,
    rect: Option<CursorClipRectPayload>,
) -> Result<(), String> {
    let label = window.label();
    if label != "main" && !label.starts_with("pip-") {
        return Err("Only application stream windows can manage cursor clip".into());
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{HWND, POINT, RECT};
        use windows::Win32::Graphics::Gdi::ClientToScreen;
        use windows::Win32::UI::WindowsAndMessaging::ClipCursor;

        let Some(r) = rect else {
            release_cursor_clip_win32();
            return Ok(());
        };
        if !r.left.is_finite()
            || !r.top.is_finite()
            || !r.width.is_finite()
            || !r.height.is_finite()
            || r.width < 2.0
            || r.height < 2.0
        {
            release_cursor_clip_win32();
            return Ok(());
        }
        let raw_hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let hwnd = HWND(raw_hwnd.0);
        if !is_window_or_descendant_foreground(hwnd) {
            release_cursor_clip_win32();
            return Ok(());
        }
        let scale = window.scale_factor().unwrap_or(1.0);
        let mut origin = POINT { x: 0, y: 0 };
        unsafe {
            if !ClientToScreen(hwnd, &mut origin).as_bool() {
                return Ok(());
            }
            let left = origin.x + (r.left * scale).round() as i32;
            let top = origin.y + (r.top * scale).round() as i32;
            let right = (origin.x + ((r.left + r.width) * scale).round() as i32).max(left + 2);
            let bottom = (origin.y + ((r.top + r.height) * scale).round() as i32).max(top + 2);
            let clip_rect = RECT {
                left,
                top,
                right,
                bottom,
            };
            if ClipCursor(Some(&clip_rect)).is_ok() {
                CURSOR_CLIP_ACTIVE.store(true, Ordering::Release);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = rect;
    Ok(())
}

fn stop_immersive_hook() {
    IMMERSIVE_ENABLED.store(false, Ordering::Release);
    #[cfg(windows)]
    if let Ok(mut guard) = IMMERSIVE_HOOK_JOIN.lock() {
        join_immersive_hook_locked(&mut guard);
    }
}

pub fn shutdown_remote_control() {
    HOST_ACTIVE.store(false, Ordering::Release);
    stop_immersive_hook();
    #[cfg(windows)]
    {
        release_cursor_clip_win32();
        stop_host_priority_hooks();
        if let Ok(mut state) = HOST_STATE.lock() {
            state.active = false;
            release_all_locked(&mut state);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vk_resolution_maps_navigation_modifiers_and_alphanumeric() {
        assert_eq!(dom_code_to_vk("KeyA"), Some((0x41, false)));
        assert_eq!(dom_code_to_vk("Digit5"), Some((0x35, false)));
        assert_eq!(dom_code_to_vk("Enter"), Some((0x0D, false)));
        assert_eq!(dom_code_to_vk("NumpadEnter"), Some((0x0D, true)));
        assert_eq!(dom_code_to_vk("ArrowLeft"), Some((0x25, true)));
        assert_eq!(dom_code_to_vk("MetaLeft"), Some((0x5B, true)));
        assert_eq!(dom_code_to_vk("F4"), Some((0x73, false)));
        assert_eq!(dom_code_to_vk("UnknownKey"), None);
        assert_eq!(vk_to_dom_code(0x5B), ("MetaLeft", "Meta"));
        assert_eq!(vk_to_dom_code(0x09), ("Tab", "Tab"));
    }

    #[test]
    fn punctuation_classification_covers_layout_sensitive_keys() {
        assert!(is_punctuation_code("Semicolon"));
        assert!(is_punctuation_code("Slash"));
        assert!(is_punctuation_code("IntlBackslash"));
        assert!(!is_punctuation_code("KeyA"));
        assert!(!is_punctuation_code("Enter"));
    }
}
