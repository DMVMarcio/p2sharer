use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

static READY: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
static SOURCE: Mutex<Option<String>> = Mutex::new(None);
static VISUALS: LazyLock<Mutex<HashMap<String, Vec<PointerVisual>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Serialize, Deserialize)]
pub struct DrawingPoint {
    x: f64,
    y: f64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct StreamDrawing {
    tool: String,
    color: String,
    size: u8,
    points: Vec<DrawingPoint>,
    text: Option<String>,
}

fn valid_stream_drawing(d: &StreamDrawing) -> bool {
    matches!(d.tool.as_str(), "brush" | "rectangle" | "ellipse" | "text")
        && d.size <= 10
        && d.color.len() == 7
        && d.color.starts_with('#')
        && d.color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
        && !d.points.is_empty()
        && d.points.len() <= 128
        && d.points.iter().all(|p| {
            p.x.is_finite()
                && p.y.is_finite()
                && (0.0..=1.0).contains(&p.x)
                && (0.0..=1.0).contains(&p.y)
        })
        && d.text
            .as_ref()
            .map(|t| t.chars().count() <= 160)
            .unwrap_or(true)
        && (d.tool != "text"
            || d.text
                .as_ref()
                .map(|t| !t.trim().is_empty() && t.chars().count() <= 160)
                .unwrap_or(false))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PointerVisual {
    id: String,
    name: String,
    color: String,
    x: f64,
    y: f64,
    expires: u64,
    ping: bool,
    drawing: Option<Arc<StreamDrawing>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PointerFrame {
    visuals: Vec<PointerVisual>,
    drawings_included: bool,
}

pub fn set_source(source: Option<String>) {
    *SOURCE.lock().unwrap() = source;
    VISUALS.lock().unwrap().remove("stream-pointer");
}

#[tauri::command]
pub fn get_stream_pointer_visuals(window: tauri::WebviewWindow) -> Vec<PointerVisual> {
    // The WebView calls this only after its transparent page has painted.
    READY.lock().unwrap().insert(window.label().to_string());
    let _ = window.show();
    VISUALS
        .lock()
        .unwrap()
        .get(window.label())
        .cloned()
        .unwrap_or_default()
}

#[cfg(windows)]
fn source_bounds(source: &str) -> Option<(i32, i32, u32, u32)> {
    use windows::Win32::{
        Foundation::{HWND, RECT},
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
        UI::WindowsAndMessaging::{IsIconic, IsWindowVisible},
    };
    let (kind, raw) = source.split_once(':')?;
    if kind == "screen" {
        // WGC uses its own monitor ordering; use that same API here.
        let monitor =
            windows_capture::monitor::Monitor::from_index(raw.parse::<usize>().ok()? + 1).ok()?;
        let monitor_handle = monitor.as_raw_hmonitor();
        use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        unsafe {
            if !GetMonitorInfoW(HMONITOR(monitor_handle as _), &mut info).as_bool() {
                return None;
            }
        }
        let r = info.rcMonitor;
        Some((
            r.left,
            r.top,
            (r.right - r.left) as u32,
            (r.bottom - r.top) as u32,
        ))
    } else if kind == "window" {
        let hwnd = HWND(raw.parse::<isize>().ok()? as _);
        unsafe {
            if IsIconic(hwnd).as_bool() || !IsWindowVisible(hwnd).as_bool() {
                return None;
            }
            let mut r = RECT::default();
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut r as *mut _ as _,
                std::mem::size_of::<RECT>() as u32,
            )
            .ok()?;
            Some((
                r.left,
                r.top,
                (r.right - r.left).max(1) as u32,
                (r.bottom - r.top).max(1) as u32,
            ))
        }
    } else {
        None
    }
}

#[tauri::command]
pub async fn update_stream_pointer_overlay(
    app: AppHandle,
    window: tauri::WebviewWindow,
    visuals: Vec<PointerVisual>,
    session_id: Option<String>,
    drawings_included: Option<bool>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can publish stream pointers".into());
    }
    let source = session_id
        .as_deref()
        .and_then(crate::screen_sources::pointer_capture_source)
        .or_else(|| {
            if session_id.is_none() {
                SOURCE.lock().unwrap().clone()
            } else {
                None
            }
        });
    let label = session_id
        .as_ref()
        .map(|id| format!("stream-pointer-{id}"))
        .unwrap_or_else(|| "stream-pointer".into());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut visuals: Vec<_> = visuals
        .into_iter()
        .filter(|v| {
            v.x.is_finite()
                && v.y.is_finite()
                && (0.0..=1.0).contains(&v.x)
                && (0.0..=1.0).contains(&v.y)
                && v.expires > now
                && v.expires <= now + 3500
                && v.drawing
                    .as_deref()
                    .map(valid_stream_drawing)
                    .unwrap_or(true)
                && v.id.len() <= 160
                && v.name.len() <= 320
                && v.color.len() <= 80
        })
        .take(1536)
        .collect();
    let included = drawings_included != Some(false);
    if !included {
        visuals.retain(|v| v.drawing.is_none());
    }
    let frame = PointerFrame {
        visuals: visuals.clone(),
        drawings_included: included,
    };
    if !included {
        if let Some(previous) = VISUALS.lock().unwrap().get(&label) {
            visuals.extend(
                previous
                    .iter()
                    .filter(|v| v.drawing.is_some())
                    .cloned()
                    .map(|mut v| {
                        v.expires = now + 3000;
                        v
                    }),
            );
        }
    }
    if source.is_none() {
        READY.lock().unwrap().remove(&label);
        VISUALS.lock().unwrap().remove(&label);
        if let Some(win) = app.get_webview_window(&label) {
            win.emit("stream-pointer-visuals", Vec::<PointerVisual>::new())
                .map_err(|e| e.to_string())?;
            win.close().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if visuals.is_empty() {
        VISUALS.lock().unwrap().remove(&label);
        if let Some(win) = app.get_webview_window(&label) {
            win.emit("stream-pointer-visuals", Vec::<PointerVisual>::new())
                .map_err(|e| e.to_string())?;
        }
        // Keep the transparent surface alive until capture stops; do not churn DWM surfaces.
        return Ok(());
    }
    // Cache changes even while a shared window is minimized; its next cursor-only frame must retain them.
    VISUALS.lock().unwrap().insert(label.clone(), visuals);
    #[cfg(windows)]
    if let Some((x, y, width, height)) = source_bounds(source.as_deref().unwrap()) {
        let win = if let Some(win) = app.get_webview_window(&label) {
            win
        } else {
            let win = WebviewWindowBuilder::new(
                &app,
                &label,
                WebviewUrl::App("index.html?pointerOverlay=1".into()),
            )
            .title("P2Sharer pointers")
            .background_color(tauri::window::Color(0, 0, 0, 0))
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .focusable(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?;
            win.set_ignore_cursor_events(true)
                .map_err(|e| e.to_string())?;
            // Do not recapture the annotations into the transmitted monitor video.
            unsafe {
                use windows::Win32::UI::WindowsAndMessaging::{
                    SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
                };
                let hwnd = win.hwnd().map_err(|e| e.to_string())?;
                SetWindowDisplayAffinity(
                    windows::Win32::Foundation::HWND(hwnd.0),
                    WDA_EXCLUDEFROMCAPTURE,
                )
                .map_err(|e| e.to_string())?;
            }
            win
        };
        let position = PhysicalPosition::new(x, y);
        let size = PhysicalSize::new(width, height);
        if win.outer_position().ok() != Some(position) {
            win.set_position(position).map_err(|e| e.to_string())?;
        }
        if win.inner_size().ok() != Some(size) {
            win.set_size(size).map_err(|e| e.to_string())?;
        }
        win.emit("stream-pointer-visuals", frame)
            .map_err(|e| e.to_string())?;
        if READY.lock().unwrap().contains(&label) && !win.is_visible().unwrap_or(false) {
            win.show().map_err(|e| e.to_string())?;
        }
    } else if let Some(win) = app.get_webview_window(&label) {
        win.emit("stream-pointer-visuals", frame)
            .map_err(|e| e.to_string())?;
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
