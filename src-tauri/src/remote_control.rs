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
    MouseDelta {
        dx: i32,
        dy: i32,
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
    image_id: String,
    mouse_locked: bool,
    host_busy: bool,
    actor_controller_id: String,
    embedded_in_video: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorImagePayload {
    pub image_id: String,
    pub width: u32,
    pub height: u32,
    pub hot_x: u32,
    pub hot_y: u32,
    pub png_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImmersiveKeyPayload {
    vk: u16,
    code: String,
    key: String,
    down: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawMouseDeltaPayload {
    dx: i32,
    dy: i32,
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
    last_cursor_handle: isize,
    last_cursor_image_id: String,
    last_cursor_capture_ms: u64,
    sent_cursor_images: HashMap<String, u64>,
    cursor_hidden_since_ms: Option<u64>,
    controller_moved_while_hidden: bool,
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
            last_cursor_handle: 0,
            last_cursor_image_id: String::new(),
            last_cursor_capture_ms: 0,
            sent_cursor_images: HashMap::new(),
            cursor_hidden_since_ms: None,
            controller_moved_while_hidden: false,
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
static RAW_LOCK_ACTIVE: AtomicBool = AtomicBool::new(false);
static RAW_LOCK_TARGET_HWND: AtomicIsize = AtomicIsize::new(0);
static RAW_LOCK_DX: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static RAW_LOCK_DY: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static RAW_LOCK_TRAP_RECT: LazyLock<Mutex<Option<(i32, i32, i32, i32)>>> =
    LazyLock::new(|| Mutex::new(None));
static RAW_LOCK_PREV_ABS: LazyLock<Mutex<Option<(i32, i32)>>> =
    LazyLock::new(|| Mutex::new(None));
static RAW_LOCK_JOIN: LazyLock<Mutex<Option<HookThreadHandle>>> =
    LazyLock::new(|| Mutex::new(None));

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

const MAX_CURSOR_IMAGE_DIM: u32 = 128;
const CURSOR_IMAGE_CACHE_LIMIT: usize = 64;
const CURSOR_RESAMPLE_MS: u64 = 120;
const LOCKED_CURSOR_HIDDEN_MS: u64 = 350;

fn rgba_from_color_and_mask(
    width: u32,
    height: u32,
    color_bgra: &[u8],
    mask_bgra: Option<&[u8]>,
) -> Vec<u8> {
    let pixel_count = (width as usize).saturating_mul(height as usize);
    let mut rgba = vec![0u8; pixel_count * 4];
    if color_bgra.len() < pixel_count * 4 {
        return rgba;
    }
    let has_alpha = color_bgra[..pixel_count * 4]
        .chunks_exact(4)
        .any(|px| px[3] != 0);
    for idx in 0..pixel_count {
        let base = idx * 4;
        let b = color_bgra[base];
        let g = color_bgra[base + 1];
        let r = color_bgra[base + 2];
        let mut a = color_bgra[base + 3];
        if !has_alpha {
            let opaque = mask_bgra
                .and_then(|mask| mask.get(base..base + 3))
                .map(|m| m[0] == 0 && m[1] == 0 && m[2] == 0)
                .unwrap_or_else(|| r != 0 || g != 0 || b != 0);
            a = if opaque { 255 } else { 0 };
        }
        rgba[base] = r;
        rgba[base + 1] = g;
        rgba[base + 2] = b;
        rgba[base + 3] = a;
    }
    rgba
}

fn rgba_from_monochrome_mask(width: u32, height: u32, mask_bgra: &[u8]) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    let pixel_count = w.saturating_mul(h);
    let mut rgba = vec![0u8; pixel_count * 4];
    let needed = pixel_count.saturating_mul(2).saturating_mul(4);
    if mask_bgra.len() < needed {
        return rgba;
    }
    let mut xor_mask = vec![false; pixel_count];
    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            let and_off = idx * 4;
            let xor_off = (pixel_count + idx) * 4;
            let and_white = mask_bgra[and_off] > 127;
            let xor_white = mask_bgra[xor_off] > 127;
            let out_off = idx * 4;
            match (and_white, xor_white) {
                (false, false) => {
                    rgba[out_off..out_off + 4].copy_from_slice(&[0, 0, 0, 255]);
                }
                (false, true) => {
                    rgba[out_off..out_off + 4].copy_from_slice(&[255, 255, 255, 255]);
                }
                (true, false) => {
                    rgba[out_off..out_off + 4].copy_from_slice(&[0, 0, 0, 0]);
                }
                (true, true) => {
                    // Inverted XOR pixels (e.g. monochrome I-beam): crisp dark core + halo added below.
                    rgba[out_off..out_off + 4].copy_from_slice(&[17, 24, 39, 255]);
                    xor_mask[idx] = true;
                }
            }
        }
    }
    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            if rgba[idx * 4 + 3] != 0 {
                continue;
            }
            let touches_xor = [
                (x > 0).then(|| idx - 1),
                (x + 1 < w).then(|| idx + 1),
                (y > 0).then(|| idx - w),
                (y + 1 < h).then(|| idx + w),
            ]
            .into_iter()
            .flatten()
            .any(|n| xor_mask[n]);
            if touches_xor {
                rgba[idx * 4..idx * 4 + 4].copy_from_slice(&[255, 255, 255, 215]);
            }
        }
    }
    rgba
}

fn clamp_cursor_bitmap(
    width: u32,
    height: u32,
    hot_x: u32,
    hot_y: u32,
    rgba: Vec<u8>,
) -> (u32, u32, u32, u32, Vec<u8>) {
    if width <= MAX_CURSOR_IMAGE_DIM && height <= MAX_CURSOR_IMAGE_DIM {
        return (
            width,
            height,
            hot_x.min(width.saturating_sub(1)),
            hot_y.min(height.saturating_sub(1)),
            rgba,
        );
    }
    let scale = (MAX_CURSOR_IMAGE_DIM as f64 / width.max(height) as f64).min(1.0);
    let dst_w = ((width as f64 * scale).round() as u32).clamp(1, MAX_CURSOR_IMAGE_DIM);
    let dst_h = ((height as f64 * scale).round() as u32).clamp(1, MAX_CURSOR_IMAGE_DIM);
    let mut scaled = vec![0u8; (dst_w * dst_h * 4) as usize];
    for dy in 0..dst_h {
        let sy = ((dy as u64 * height as u64) / dst_h as u64).min(height.saturating_sub(1) as u64)
            as u32;
        for dx in 0..dst_w {
            let sx = ((dx as u64 * width as u64) / dst_w as u64)
                .min(width.saturating_sub(1) as u64) as u32;
            let src_idx = ((sy * width + sx) * 4) as usize;
            let dst_idx = ((dy * dst_w + dx) * 4) as usize;
            scaled[dst_idx..dst_idx + 4].copy_from_slice(&rgba[src_idx..src_idx + 4]);
        }
    }
    let scaled_hx = ((hot_x as f64 * scale).round() as u32).min(dst_w.saturating_sub(1));
    let scaled_hy = ((hot_y as f64 * scale).round() as u32).min(dst_h.saturating_sub(1));
    (dst_w, dst_h, scaled_hx, scaled_hy, scaled)
}

fn encode_cursor_png_with_hash(
    width: u32,
    height: u32,
    hot_x: u32,
    hot_y: u32,
    rgba: &[u8],
) -> Result<CursorImagePayload, String> {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};

    if width == 0 || height == 0 || rgba.len() != (width as usize * height as usize * 4) {
        return Err("Invalid cursor RGBA dimensions".to_string());
    }
    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer
            .write_image_data(rgba)
            .map_err(|e| e.to_string())?;
    }
    let mut hasher = Sha256::new();
    hasher.update(format!("{width}:{height}:{hot_x}:{hot_y}:").as_bytes());
    hasher.update(&png_bytes);
    let digest = hasher.finalize();
    let image_id = digest[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let png_base64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    Ok(CursorImagePayload {
        image_id,
        width,
        height,
        hot_x,
        hot_y,
        png_base64,
    })
}

#[cfg(windows)]
fn map_hcursor_to_shape(h: windows::Win32::UI::WindowsAndMessaging::HCURSOR) -> String {
    use windows::Win32::UI::WindowsAndMessaging::{
        LoadCursorW, IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_IBEAM, IDC_NO,
        IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE, IDC_WAIT,
    };
    let matches = |id| unsafe { LoadCursorW(None, id).map(|c| c == h).unwrap_or(false) };
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

#[cfg(windows)]
fn read_cursor_info_win32() -> Option<(bool, isize, String)> {
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorInfo, CURSORINFO, CURSOR_SHOWING};
    let mut ci = CURSORINFO {
        cbSize: std::mem::size_of::<CURSORINFO>() as u32,
        ..Default::default()
    };
    unsafe {
        if GetCursorInfo(&mut ci).is_err() {
            return None;
        }
        let showing = (ci.flags.0 & CURSOR_SHOWING.0) != 0;
        let shape = if showing {
            map_hcursor_to_shape(ci.hCursor)
        } else {
            "default".to_string()
        };
        Some((showing, ci.hCursor.0 as isize, shape))
    }
}

#[cfg(windows)]
fn read_cursor_shape() -> String {
    read_cursor_info_win32()
        .map(|(_, _, shape)| shape)
        .unwrap_or_else(|| "default".to_string())
}

#[cfg(windows)]
fn capture_hcursor_png_win32(hcursor_raw: isize) -> Option<CursorImagePayload> {
    use std::ffi::c_void;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CopyIcon, DestroyIcon, GetIconInfo, HICON, ICONINFO,
    };

    if hcursor_raw == 0 {
        return None;
    }

    struct OwnedIcon(HICON);
    impl Drop for OwnedIcon {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = DestroyIcon(self.0);
                }
            }
        }
    }
    struct IconBitmaps(ICONINFO);
    impl Drop for IconBitmaps {
        fn drop(&mut self) {
            unsafe {
                if !self.0.hbmColor.is_invalid() {
                    let _ = DeleteObject(HGDIOBJ(self.0.hbmColor.0));
                }
                if !self.0.hbmMask.is_invalid() {
                    let _ = DeleteObject(HGDIOBJ(self.0.hbmMask.0));
                }
            }
        }
    }
    struct ScreenDc(windows::Win32::Graphics::Gdi::HDC);
    impl Drop for ScreenDc {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = ReleaseDC(None, self.0);
                }
            }
        }
    }

    unsafe {
        let orig = HICON(hcursor_raw as *mut c_void);
        let copied = CopyIcon(orig).ok().map(OwnedIcon);
        let icon_handle = copied.as_ref().map(|o| o.0).unwrap_or(orig);
        let mut raw_info = ICONINFO::default();
        if GetIconInfo(icon_handle, &mut raw_info).is_err() {
            return None;
        }
        let guard = IconBitmaps(raw_info);
        let has_color = !guard.0.hbmColor.is_invalid();
        let target_bm: HBITMAP = if has_color {
            guard.0.hbmColor
        } else {
            guard.0.hbmMask
        };
        if target_bm.is_invalid() {
            return None;
        }
        let mut bm = BITMAP::default();
        if GetObjectW(
            HGDIOBJ(target_bm.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut BITMAP as *mut c_void),
        ) == 0
        {
            return None;
        }
        let raw_w = bm.bmWidth.max(0) as u32;
        let raw_h = bm.bmHeight.unsigned_abs();
        if raw_w == 0 || raw_h == 0 || raw_w > 512 || raw_h > 1024 {
            return None;
        }
        let dc = ScreenDc(GetDC(None));
        if dc.0.is_invalid() {
            return None;
        }
        let read_bgra = |hbm: HBITMAP, w: u32, h: u32| -> Option<Vec<u8>> {
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };
            let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
            let lines = GetDIBits(
                dc.0,
                hbm,
                0,
                h,
                Some(buf.as_mut_ptr() as *mut c_void),
                &mut bmi,
                DIB_RGB_COLORS,
            );
            if lines <= 0 {
                None
            } else {
                Some(buf)
            }
        };

        let (height, rgba) = if has_color {
            let color = read_bgra(guard.0.hbmColor, raw_w, raw_h)?;
            let mask = if !guard.0.hbmMask.is_invalid() {
                read_bgra(guard.0.hbmMask, raw_w, raw_h)
            } else {
                None
            };
            (
                raw_h,
                rgba_from_color_and_mask(raw_w, raw_h, &color, mask.as_deref()),
            )
        } else {
            let logical_h = raw_h / 2;
            if logical_h == 0 {
                return None;
            }
            let mask = read_bgra(guard.0.hbmMask, raw_w, raw_h)?;
            (logical_h, rgba_from_monochrome_mask(raw_w, logical_h, &mask))
        };

        let (final_w, final_h, hot_x, hot_y, final_rgba) = clamp_cursor_bitmap(
            raw_w,
            height,
            guard.0.xHotspot,
            guard.0.yHotspot,
            rgba,
        );
        encode_cursor_png_with_hash(final_w, final_h, hot_x, hot_y, &final_rgba).ok()
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
fn is_mouse_locked_win32(
    source_bounds: (i32, i32, u32, u32),
    cursor_showing: bool,
    hidden_since_ms: Option<u64>,
    controller_moved_while_hidden: bool,
    now: u64,
) -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClipCursor, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    };

    let mut clip = RECT::default();
    let clip_dims = unsafe {
        if GetClipCursor(&mut clip).is_ok() {
            let cw = (clip.right - clip.left).max(0) as u32;
            let ch = (clip.bottom - clip.top).max(0) as u32;
            Some((cw, ch))
        } else {
            None
        }
    };
    let (src_w, src_h) = (source_bounds.2.max(1), source_bounds.3.max(1));
    let (virt_w, virt_h) = unsafe {
        (
            GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1) as u32,
            GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1) as u32,
        )
    };

    if let Some((cw, ch)) = clip_dims {
        // A tiny clip box (<= 32px, e.g. 1x1 game trap) indicates locked relative capture even if cursor flag stays set.
        if cw > 0 && ch > 0 && cw <= 32 && ch <= 32 {
            return true;
        }
        if !cursor_showing && cw > 0 && ch > 0 && (cw + 4 < virt_w.min(src_w) || ch + 4 < virt_h.min(src_h))
        {
            return true;
        }
    }

    if cursor_showing {
        return false;
    }

    controller_moved_while_hidden
        || hidden_since_ms
            .map(|since| now.saturating_sub(since) >= LOCKED_CURSOR_HIDDEN_MS)
            .unwrap_or(false)
}

#[cfg(windows)]
fn sample_cursor_and_image_locked(
    state: &mut HostControlState,
    host_busy: bool,
) -> Option<(CursorSyncPayload, Option<isize>)> {
    let now = now_ms();
    let (session_id, source, embedded_in_video) =
        crate::screen_sources::active_cursor_session_info(state.last_session_id.as_deref())?;
    let bounds @ (left, top, width, height) = crate::stream_pointer::source_bounds(&source)?;
    let (px, py) = read_cursor_pos()?;
    let (cursor_showing, cursor_handle, cursor_shape) =
        read_cursor_info_win32().unwrap_or((true, 0, "default".to_string()));
    state.last_cursor_shape = cursor_shape.clone();

    if cursor_showing {
        state.cursor_hidden_since_ms = None;
        state.controller_moved_while_hidden = false;
    } else if state.cursor_hidden_since_ms.is_none() {
        state.cursor_hidden_since_ms = Some(now);
    }

    let mouse_locked = is_mouse_locked_win32(
        bounds,
        cursor_showing,
        state.cursor_hidden_since_ms,
        state.controller_moved_while_hidden,
        now,
    );

    let capture_handle = if !cursor_showing || cursor_handle == 0 || mouse_locked {
        None
    } else if cursor_handle != state.last_cursor_handle
        || state.last_cursor_image_id.is_empty()
        || now.saturating_sub(state.last_cursor_capture_ms) >= CURSOR_RESAMPLE_MS
    {
        state.last_cursor_handle = cursor_handle;
        state.last_cursor_capture_ms = now;
        Some(cursor_handle)
    } else {
        None
    };

    let image_id = state.last_cursor_image_id.clone();

    let inside = width > 1
        && height > 1
        && px >= left
        && px < left + width as i32
        && py >= top
        && py < top + height as i32;
    let visible = inside && cursor_showing && !mouse_locked;
    let x = ((px - left) as f64 / (width.saturating_sub(1).max(1) as f64)).clamp(0.0, 1.0);
    let y = ((py - top) as f64 / (height.saturating_sub(1).max(1) as f64)).clamp(0.0, 1.0);
    let actor = if host_busy {
        "host".to_string()
    } else {
        state
            .last_mouse_actor_id
            .as_deref()
            .unwrap_or("host")
            .to_string()
    };

    Some((
        CursorSyncPayload {
            session_id,
            active: true,
            visible,
            x,
            y,
            cursor_shape,
            image_id,
            mouse_locked,
            host_busy,
            actor_controller_id: actor,
            embedded_in_video,
        },
        capture_handle,
    ))
}

#[cfg(windows)]
fn store_captured_cursor_image(
    payload: CursorImagePayload,
) -> (String, Option<CursorImagePayload>) {
    let id = payload.image_id.clone();
    let Ok(mut state) = HOST_STATE.lock() else {
        return (id, None);
    };
    state.last_cursor_image_id = id.clone();
    let already_sent = state.sent_cursor_images.contains_key(&id);
    if !already_sent && state.sent_cursor_images.len() >= CURSOR_IMAGE_CACHE_LIMIT {
        if let Some(oldest_key) = state
            .sent_cursor_images
            .iter()
            .min_by_key(|(_, ts)| *ts)
            .map(|(k, _)| k.clone())
        {
            state.sent_cursor_images.remove(&oldest_key);
        }
    }
    state.sent_cursor_images.insert(id.clone(), now_ms());
    (id, if already_sent { None } else { Some(payload) })
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
            image_id: String::new(),
            mouse_locked: false,
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
                state.last_cursor_handle = 0;
                state.last_cursor_image_id.clear();
                state.last_cursor_capture_ms = 0;
                state.sent_cursor_images.clear();
                state.cursor_hidden_since_ms = None;
                state.controller_moved_while_hidden = false;
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
                state.sent_cursor_images.clear();
                state.cursor_hidden_since_ms = None;
                state.controller_moved_while_hidden = false;
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
                    let (still_active, paused, shape, sync_and_image) = {
                        let Ok(mut state) = HOST_STATE.lock() else {
                            break;
                        };
                        if !state.active {
                            state.monitor_running = false;
                            break;
                        }
                        let paused = poll_host_activity_locked(&mut state);
                        let sampled = sample_cursor_and_image_locked(&mut state, paused);
                        let shape = state.last_cursor_shape.clone();
                        (true, paused, shape, sampled)
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
                    if let Some((mut sync_payload, capture_handle)) = sync_and_image {
                        // Capture HCURSOR outside HOST_STATE lock so SendInput never blocks on GDI/PNG/SHA256.
                        let new_image = if let Some(handle) = capture_handle {
                            capture_hcursor_png_win32(handle).and_then(|img| {
                                let (image_id, unseen) = store_captured_cursor_image(img);
                                sync_payload.image_id = image_id;
                                unseen
                            })
                        } else {
                            None
                        };
                        if let Some(img) = new_image {
                            let _ = app.emit_to("main", "remote-control-cursor-image", img);
                        }
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
                | RemoteInputEvent::MouseDelta { .. }
                | RemoteInputEvent::MouseButton { .. }
                | RemoteInputEvent::MouseWheel { .. }
        );
        if is_mouse_event {
            state.last_mouse_actor_id = Some(controller_id.clone());
            if state.cursor_hidden_since_ms.is_some()
                && matches!(
                    event,
                    RemoteInputEvent::MouseMove { .. } | RemoteInputEvent::MouseDelta { .. }
                )
            {
                state.controller_moved_while_hidden = true;
            }
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
            RemoteInputEvent::MouseDelta { dx, dy } => {
                let clamped_dx = dx.clamp(-10_000, 10_000);
                let clamped_dy = dy.clamp(-10_000, 10_000);
                if clamped_dx != 0 || clamped_dy != 0 {
                    let input = INPUT {
                        r#type: INPUT_MOUSE,
                        Anonymous: INPUT_0 {
                            mi: MOUSEINPUT {
                                dx: clamped_dx,
                                dy: clamped_dy,
                                mouseData: 0,
                                dwFlags: MOUSEEVENTF_MOVE,
                                time: 0,
                                dwExtraInfo: P2SHARER_INPUT_TAG,
                            },
                        },
                    };
                    send_win32_inputs(&[input]);
                    moved_cursor = true;
                }
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

const RAW_DELTA_FLUSH_US: u128 = 3000;
const RAW_CLIP_CHECK_MS: u64 = 25;

pub(crate) fn compute_centered_clip_trap(
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
) -> (i32, i32, i32, i32) {
    let w = (right - left).max(2);
    let h = (bottom - top).max(2);
    let trap_w = (w / 2).clamp(2, 64);
    let trap_h = (h / 2).clamp(2, 64);
    let cx = left + w / 2;
    let cy = top + h / 2;
    let t_left = (cx - trap_w / 2).max(left);
    let t_top = (cy - trap_h / 2).max(top);
    let t_right = (t_left + trap_w).min(left + w).max(t_left + 2);
    let t_bottom = (t_top + trap_h).min(top + h).max(t_top + 2);
    (t_left, t_top, t_right, t_bottom)
}

#[cfg(windows)]
fn rect_from_client_payload(
    window: &tauri::WebviewWindow,
    hwnd: windows::Win32::Foundation::HWND,
    r: &CursorClipRectPayload,
) -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    if !r.left.is_finite()
        || !r.top.is_finite()
        || !r.width.is_finite()
        || !r.height.is_finite()
        || r.width < 2.0
        || r.height < 2.0
    {
        return None;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let mut origin = POINT { x: 0, y: 0 };
    unsafe {
        if !ClientToScreen(hwnd, &mut origin).as_bool() {
            return None;
        }
    }
    let left = origin.x + (r.left * scale).round() as i32;
    let top = origin.y + (r.top * scale).round() as i32;
    let right = (origin.x + ((r.left + r.width) * scale).round() as i32).max(left + 2);
    let bottom = (origin.y + ((r.top + r.height) * scale).round() as i32).max(top + 2);
    Some((left, top, right, bottom))
}

#[cfg(windows)]
fn apply_trap_clip_win32(trap: (i32, i32, i32, i32), recenter_if_outside: bool) {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{ClipCursor, GetCursorPos, SetCursorPos};
    let (left, top, right, bottom) = trap;
    if recenter_if_outside {
        let mut pt = POINT::default();
        unsafe {
            if GetCursorPos(&mut pt).is_ok()
                && (pt.x < left || pt.x >= right || pt.y < top || pt.y >= bottom)
            {
                let _ = SetCursorPos((left + right) / 2, (top + bottom) / 2);
            }
        }
    }
    let clip_rect = RECT {
        left,
        top,
        right,
        bottom,
    };
    unsafe {
        if ClipCursor(Some(&clip_rect)).is_ok() {
            CURSOR_CLIP_ACTIVE.store(true, Ordering::Release);
        }
    }
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

#[cfg(windows)]
unsafe extern "system" fn raw_mouse_wnd_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Input::{
        GetRawInputData, HRAWINPUT, RAWINPUT, RAWINPUTHEADER, RID_INPUT, RIM_TYPEMOUSE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DefWindowProcW, WM_INPUT};
    const MOUSE_MOVE_ABSOLUTE_FLAG: u16 = 0x0001;

    if msg == WM_INPUT && RAW_LOCK_ACTIVE.load(Ordering::Acquire) {
        let target = HWND(RAW_LOCK_TARGET_HWND.load(Ordering::Acquire) as *mut _);
        if is_window_or_descendant_foreground(target) {
            let mut raw = std::mem::MaybeUninit::<RAWINPUT>::uninit();
            let mut size = std::mem::size_of::<RAWINPUT>() as u32;
            let bytes = GetRawInputData(
                HRAWINPUT(lparam.0 as *mut _),
                RID_INPUT,
                Some(raw.as_mut_ptr().cast()),
                &mut size,
                std::mem::size_of::<RAWINPUTHEADER>() as u32,
            );
            if bytes != u32::MAX && (bytes as usize) >= std::mem::size_of::<RAWINPUTHEADER>() {
                let raw = raw.assume_init();
                if raw.header.dwType == RIM_TYPEMOUSE.0 {
                    let mouse = raw.data.mouse;
                    if mouse.ulExtraInformation != (P2SHARER_INPUT_TAG as u32) {
                        let (dx, dy) = if (mouse.usFlags.0 & MOUSE_MOVE_ABSOLUTE_FLAG) != 0 {
                            let mut guard = RAW_LOCK_PREV_ABS.lock().ok();
                            let prev = guard.as_deref_mut().and_then(|opt| {
                                let p = *opt;
                                *opt = Some((mouse.lLastX, mouse.lLastY));
                                p
                            });
                            if let Some((px, py)) = prev {
                                ((mouse.lLastX - px).clamp(-4096, 4096), (mouse.lLastY - py).clamp(-4096, 4096))
                            } else {
                                (0, 0)
                            }
                        } else {
                            if let Ok(mut guard) = RAW_LOCK_PREV_ABS.lock() {
                                *guard = None;
                            }
                            (mouse.lLastX, mouse.lLastY)
                        };
                        if dx != 0 || dy != 0 {
                            RAW_LOCK_DX.fetch_add(dx, Ordering::AcqRel);
                            RAW_LOCK_DY.fetch_add(dy, Ordering::AcqRel);
                        }
                    }
                }
            }
        }
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

#[cfg(windows)]
fn flush_raw_mouse_deltas(app: &AppHandle, label: &str) -> bool {
    let dx = RAW_LOCK_DX.swap(0, Ordering::AcqRel);
    let dy = RAW_LOCK_DY.swap(0, Ordering::AcqRel);
    if dx == 0 && dy == 0 {
        return false;
    }
    let _ = app.emit_to(label, "remote-control-raw-delta", RawMouseDeltaPayload { dx, dy });
    true
}

#[cfg(windows)]
fn stop_raw_mouse_lock() {
    RAW_LOCK_ACTIVE.store(false, Ordering::Release);
    RAW_LOCK_TARGET_HWND.store(0, Ordering::Release);
    RAW_LOCK_DX.store(0, Ordering::Release);
    RAW_LOCK_DY.store(0, Ordering::Release);
    if let Ok(mut guard) = RAW_LOCK_TRAP_RECT.lock() {
        *guard = None;
    }
    if let Ok(mut guard) = RAW_LOCK_PREV_ABS.lock() {
        *guard = None;
    }
    release_cursor_clip_win32();
    if let Ok(mut guard) = RAW_LOCK_JOIN.lock() {
        join_immersive_hook_locked(&mut guard);
    }
}

#[tauri::command]
pub fn set_remote_control_mouse_lock(
    app: AppHandle,
    window: tauri::WebviewWindow,
    enabled: bool,
    rect: Option<CursorClipRectPayload>,
) -> Result<bool, String> {
    let label = window.label().to_string();
    if label != "main" && !label.starts_with("pip-") {
        return Err("Only application stream windows can manage mouse lock".into());
    }
    #[cfg(windows)]
    {
        use windows::core::w;
        use windows::Win32::Foundation::{HINSTANCE, HWND, RECT};
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::System::Threading::GetCurrentThreadId;
        use windows::Win32::UI::Input::{
            RegisterRawInputDevices, RAWINPUTDEVICE, RIDEV_INPUTSINK, RIDEV_REMOVE,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, DispatchMessageW, GetClipCursor,
            MsgWaitForMultipleObjectsEx, PeekMessageW, RegisterClassW, TranslateMessage,
            HWND_MESSAGE, MSG, MWMO_INPUTAVAILABLE, PM_REMOVE, QS_ALLINPUT, WM_QUIT, WNDCLASSW,
            WINDOW_EX_STYLE, WINDOW_STYLE,
        };

        if !enabled {
            stop_raw_mouse_lock();
            return Ok(false);
        }

        let Some(r) = rect else {
            stop_raw_mouse_lock();
            return Ok(false);
        };
        let raw_hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let hwnd = HWND(raw_hwnd.0);
        if !is_window_or_descendant_foreground(hwnd) {
            stop_raw_mouse_lock();
            return Ok(false);
        }
        let Some((left, top, right, bottom)) = rect_from_client_payload(&window, hwnd, &r) else {
            stop_raw_mouse_lock();
            return Ok(false);
        };
        let trap = compute_centered_clip_trap(left, top, right, bottom);
        let hwnd_isize = raw_hwnd.0 as isize;

        let already_running = RAW_LOCK_ACTIVE.load(Ordering::Acquire)
            && RAW_LOCK_TARGET_HWND.load(Ordering::Acquire) == hwnd_isize
            && RAW_LOCK_JOIN
                .lock()
                .map(|g| g.as_ref().is_some_and(|h| !h.join.is_finished()))
                .unwrap_or(false);

        if let Ok(mut guard) = RAW_LOCK_TRAP_RECT.lock() {
            *guard = Some(trap);
        }
        apply_trap_clip_win32(trap, true);

        if already_running {
            return Ok(true);
        }

        stop_raw_mouse_lock();
        if let Ok(mut guard) = RAW_LOCK_TRAP_RECT.lock() {
            *guard = Some(trap);
        }
        RAW_LOCK_TARGET_HWND.store(hwnd_isize, Ordering::Release);
        RAW_LOCK_DX.store(0, Ordering::Release);
        RAW_LOCK_DY.store(0, Ordering::Release);
        RAW_LOCK_ACTIVE.store(true, Ordering::Release);
        apply_trap_clip_win32(trap, true);

        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<u32, String>>(1);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let app_handle = app.clone();
        let target_label = label.clone();

        let join = std::thread::spawn(move || unsafe {
            let tid = GetCurrentThreadId();
            let instance = match GetModuleHandleW(None) {
                Ok(m) => HINSTANCE(m.0),
                Err(err) => {
                    let _ = ready_tx.send(Err(err.to_string()));
                    return;
                }
            };
            let class_name = w!("P2SharerRawMouseSink");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(raw_mouse_wnd_proc),
                hInstance: instance,
                lpszClassName: class_name,
                ..Default::default()
            };
            let _ = RegisterClassW(&wc);
            let msg_hwnd = match CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class_name,
                None,
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                None,
                instance,
                None,
            ) {
                Ok(h) => h,
                Err(err) => {
                    let _ = ready_tx.send(Err(err.to_string()));
                    return;
                }
            };

            let rid = RAWINPUTDEVICE {
                usUsagePage: 0x01,
                usUsage: 0x02,
                dwFlags: RIDEV_INPUTSINK,
                hwndTarget: msg_hwnd,
            };
            if let Err(err) = RegisterRawInputDevices(&[rid], std::mem::size_of::<RAWINPUTDEVICE>() as u32) {
                let _ = DestroyWindow(msg_hwnd);
                let _ = ready_tx.send(Err(err.to_string()));
                return;
            }
            let _ = ready_tx.send(Ok(tid));

            let mut last_flush = std::time::Instant::now()
                .checked_sub(std::time::Duration::from_millis(10))
                .unwrap_or_else(std::time::Instant::now);
            let mut last_clip_check = std::time::Instant::now();
            let mut lost_focus = false;

            while !stop_thread.load(Ordering::Acquire) && RAW_LOCK_ACTIVE.load(Ordering::Acquire) {
                let mut msg = MSG::default();
                let mut got_quit = false;
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    if msg.message == WM_QUIT {
                        got_quit = true;
                        break;
                    }
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                if got_quit || stop_thread.load(Ordering::Acquire) || !RAW_LOCK_ACTIVE.load(Ordering::Acquire) {
                    break;
                }

                let has_pending =
                    RAW_LOCK_DX.load(Ordering::Acquire) != 0 || RAW_LOCK_DY.load(Ordering::Acquire) != 0;
                if has_pending && last_flush.elapsed().as_micros() >= RAW_DELTA_FLUSH_US {
                    if flush_raw_mouse_deltas(&app_handle, &target_label) {
                        last_flush = std::time::Instant::now();
                    }
                }

                if last_clip_check.elapsed().as_millis() >= u128::from(RAW_CLIP_CHECK_MS) {
                    last_clip_check = std::time::Instant::now();
                    let target = HWND(RAW_LOCK_TARGET_HWND.load(Ordering::Acquire) as *mut _);
                    if !is_window_or_descendant_foreground(target) {
                        lost_focus = true;
                        break;
                    }
                    if let Ok(guard) = RAW_LOCK_TRAP_RECT.lock() {
                        if let Some((tl, tt, tr, tb)) = *guard {
                            let mut current_clip = RECT::default();
                            if GetClipCursor(&mut current_clip).is_err()
                                || current_clip.left != tl
                                || current_clip.top != tt
                                || current_clip.right != tr
                                || current_clip.bottom != tb
                            {
                                apply_trap_clip_win32((tl, tt, tr, tb), false);
                            }
                        }
                    }
                }

                let pending_after =
                    RAW_LOCK_DX.load(Ordering::Acquire) != 0 || RAW_LOCK_DY.load(Ordering::Acquire) != 0;
                let wait_ms = if pending_after { 2 } else { RAW_CLIP_CHECK_MS as u32 };
                let _ = MsgWaitForMultipleObjectsEx(None, wait_ms, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
            }

            let remove_rid = RAWINPUTDEVICE {
                usUsagePage: 0x01,
                usUsage: 0x02,
                dwFlags: RIDEV_REMOVE,
                hwndTarget: HWND::default(),
            };
            let _ = RegisterRawInputDevices(
                &[remove_rid],
                std::mem::size_of::<RAWINPUTDEVICE>() as u32,
            );
            release_cursor_clip_win32();
            RAW_LOCK_DX.store(0, Ordering::Release);
            RAW_LOCK_DY.store(0, Ordering::Release);
            let _ = DestroyWindow(msg_hwnd);
            if lost_focus && RAW_LOCK_ACTIVE.swap(false, Ordering::AcqRel) {
                RAW_LOCK_TARGET_HWND.store(0, Ordering::Release);
                if let Ok(mut guard) = RAW_LOCK_TRAP_RECT.lock() {
                    *guard = None;
                }
                let _ = app_handle.emit_to(&target_label, "remote-control-raw-lock-lost", ());
            }
        });

        match ready_rx.recv_timeout(std::time::Duration::from_millis(800)) {
            Ok(Ok(thread_id)) => {
                if let Ok(mut guard) = RAW_LOCK_JOIN.lock() {
                    *guard = Some(HookThreadHandle {
                        thread_id,
                        stop,
                        join,
                    });
                }
                Ok(true)
            }
            Ok(Err(err)) => {
                RAW_LOCK_ACTIVE.store(false, Ordering::Release);
                release_cursor_clip_win32();
                let _ = join.join();
                Err(err)
            }
            Err(_) => {
                RAW_LOCK_ACTIVE.store(false, Ordering::Release);
                release_cursor_clip_win32();
                Err("Timed out starting raw mouse lock".into())
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, window, enabled, rect);
        Ok(false)
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
        use windows::Win32::Foundation::{HWND, RECT};
        use windows::Win32::UI::WindowsAndMessaging::ClipCursor;

        if RAW_LOCK_ACTIVE.load(Ordering::Acquire) {
            return Ok(());
        }
        let Some(r) = rect else {
            release_cursor_clip_win32();
            return Ok(());
        };
        let raw_hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let hwnd = HWND(raw_hwnd.0);
        if !is_window_or_descendant_foreground(hwnd) {
            release_cursor_clip_win32();
            return Ok(());
        }
        let Some((left, top, right, bottom)) = rect_from_client_payload(&window, hwnd, &r) else {
            release_cursor_clip_win32();
            return Ok(());
        };
        let clip_rect = RECT {
            left,
            top,
            right,
            bottom,
        };
        unsafe {
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
        stop_raw_mouse_lock();
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

    #[test]
    fn cursor_bitmap_conversion_and_png_encoding_produce_stable_ids() {
        // 2x2 monochrome cursor: (black, white) on row 0; (transparent, inverted XOR) on row 1.
        let mono_bgra = vec![
            0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 0, 255, 255, 255, 0,
            0, 0, 0, 0, 255, 255, 255, 0, 0, 0, 0, 0, 255, 255, 255, 0,
        ];
        let mono_rgba = rgba_from_monochrome_mask(2, 2, &mono_bgra);
        assert_eq!(&mono_rgba[0..4], &[0, 0, 0, 255]);
        assert_eq!(&mono_rgba[4..8], &[255, 255, 255, 255]);
        // Transparent neighbor gets crisp light outline halo next to the XOR pixel at (1, 1)
        assert_eq!(&mono_rgba[8..12], &[255, 255, 255, 215]);
        assert_eq!(&mono_rgba[12..16], &[17, 24, 39, 255]);

        let color_bgra = vec![10, 20, 30, 0, 40, 50, 60, 0];
        let color_mask = vec![0, 0, 0, 0, 255, 255, 255, 0];
        let color_rgba = rgba_from_color_and_mask(2, 1, &color_bgra, Some(&color_mask));
        assert_eq!(&color_rgba[0..4], &[30, 20, 10, 255]);
        assert_eq!(&color_rgba[4..8], &[60, 50, 40, 0]);

        let p1 = encode_cursor_png_with_hash(2, 2, 0, 1, &mono_rgba).expect("png encode");
        let p2 = encode_cursor_png_with_hash(2, 2, 0, 1, &mono_rgba).expect("png encode");
        let p3 = encode_cursor_png_with_hash(2, 2, 1, 1, &mono_rgba).expect("png encode");
        assert_eq!(p1.image_id, p2.image_id);
        assert_ne!(p1.image_id, p3.image_id);
        assert!(!p1.png_base64.is_empty());

        let (sw, sh, hx, hy, scaled) = clamp_cursor_bitmap(256, 256, 64, 128, vec![255; 256 * 256 * 4]);
        assert_eq!((sw, sh, hx, hy), (128, 128, 32, 64));
        assert_eq!(scaled.len(), 128 * 128 * 4);
    }

    #[test]
    fn mouse_delta_event_deserializes() {
        let ev: RemoteInputEvent =
            serde_json::from_str(r#"{"kind":"mouseDelta","dx":-18,"dy":42}"#)
                .expect("mouseDelta json");
        match ev {
            RemoteInputEvent::MouseDelta { dx, dy } => assert_eq!((dx, dy), (-18, 42)),
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn centered_clip_trap_stays_inside_video_bounds() {
        let trap = compute_centered_clip_trap(100, 200, 1380, 920);
        assert_eq!(trap, (708, 528, 772, 592));
        assert!(trap.0 >= 100 && trap.1 >= 200 && trap.2 <= 1380 && trap.3 <= 920);

        let small = compute_centered_clip_trap(10, 20, 18, 28);
        assert!(small.0 >= 10 && small.1 >= 20 && small.2 <= 18 && small.3 <= 28);
        assert!(small.2 - small.0 >= 2 && small.3 - small.1 >= 2);
    }
}
