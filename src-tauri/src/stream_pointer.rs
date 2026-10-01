use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use serde::{Deserialize, Serialize};

static SOURCE: Mutex<Option<String>> = Mutex::new(None);
static VISUALS: Mutex<Vec<PointerVisual>> = Mutex::new(Vec::new());

#[derive(Clone, Serialize, Deserialize)]
pub struct PointerVisual {
    id: String, name: String, color: String, x: f64, y: f64, expires: u64, ping: bool,
}

pub fn set_source(source: Option<String>) {
    *SOURCE.lock().unwrap() = source;
    VISUALS.lock().unwrap().clear();
}

#[tauri::command]
pub fn get_stream_pointer_visuals() -> Vec<PointerVisual> {
    VISUALS.lock().unwrap().clone()
}

#[cfg(windows)]
fn source_bounds(source: &str) -> Option<(i32, i32, u32, u32)> {
    use windows::Win32::{Foundation::{HWND, RECT}, UI::WindowsAndMessaging::{IsIconic, IsWindowVisible}, Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS}};
    let (kind, raw) = source.split_once(':')?;
    if kind == "screen" {
        // WGC uses its own monitor ordering; use that same API here.
        let monitor = windows_capture::monitor::Monitor::from_index(raw.parse::<usize>().ok()? + 1).ok()?;
        let monitor_handle = monitor.as_raw_hmonitor();
        use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITORINFO, HMONITOR};
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        unsafe { if !GetMonitorInfoW(HMONITOR(monitor_handle as _), &mut info).as_bool() { return None; } }
        let r = info.rcMonitor;
        Some((r.left, r.top, (r.right-r.left) as u32, (r.bottom-r.top) as u32))
    } else if kind == "window" {
        let hwnd = HWND(raw.parse::<isize>().ok()? as _);
        unsafe {
            if IsIconic(hwnd).as_bool() || !IsWindowVisible(hwnd).as_bool() { return None; }
            let mut r = RECT::default();
            DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut _ as _, std::mem::size_of::<RECT>() as u32).ok()?;
            Some((r.left, r.top, (r.right-r.left).max(1) as u32, (r.bottom-r.top).max(1) as u32))
        }
    } else { None }
}

#[tauri::command]
pub async fn update_stream_pointer_overlay(app: AppHandle, window: tauri::WebviewWindow, visuals: Vec<PointerVisual>) -> Result<(), String> {
    if window.label() != "main" { return Err("Only the main window can publish stream pointers".into()); }
    let source = SOURCE.lock().unwrap().clone();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let visuals: Vec<_> = visuals.into_iter().filter(|v| v.x.is_finite() && v.y.is_finite() &&
        (0.0..=1.0).contains(&v.x) && (0.0..=1.0).contains(&v.y) && v.expires > now &&
        v.expires <= now + 3500 && v.id.len() <= 160 && v.name.len() <= 320 && v.color.len() <= 80).take(256).collect();
    if source.is_none() || visuals.is_empty() {
        VISUALS.lock().unwrap().clear();
        if let Some(win) = app.get_webview_window("stream-pointer") {
            win.emit("stream-pointer-visuals", Vec::<PointerVisual>::new()).map_err(|e| e.to_string())?;
            win.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    #[cfg(windows)]
    if let Some((x, y, width, height)) = source_bounds(source.as_deref().unwrap()) {
        let win = if let Some(win) = app.get_webview_window("stream-pointer") { win } else {
            let win = WebviewWindowBuilder::new(&app, "stream-pointer", WebviewUrl::App("index.html?pointerOverlay=1".into()))
                .title("P2Sharer pointers").transparent(true).decorations(false).shadow(false)
                .always_on_top(true).skip_taskbar(true).resizable(false).focused(false).focusable(false).visible(false)
                .build().map_err(|e| e.to_string())?;
            win.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
            // Do not recapture the annotations into the transmitted monitor video.
            unsafe {
                use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};
                let hwnd = win.hwnd().map_err(|e| e.to_string())?;
                SetWindowDisplayAffinity(windows::Win32::Foundation::HWND(hwnd.0), WDA_EXCLUDEFROMCAPTURE).map_err(|e| e.to_string())?;
            }
            win
        };
        let position = PhysicalPosition::new(x, y);
        let size = PhysicalSize::new(width, height);
        if win.outer_position().ok() != Some(position) { win.set_position(position).map_err(|e| e.to_string())?; }
        if win.inner_size().ok() != Some(size) { win.set_size(size).map_err(|e| e.to_string())?; }
        *VISUALS.lock().unwrap() = visuals.clone();
        win.emit("stream-pointer-visuals", visuals).map_err(|e| e.to_string())?;
        win.show().map_err(|e| e.to_string())?;
    } else if let Some(win) = app.get_webview_window("stream-pointer") { win.hide().map_err(|e| e.to_string())?; }
    Ok(())
}
