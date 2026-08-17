use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use image::imageops::FilterType;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use xcap::{Monitor, Window};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MonitorSource {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WindowSource {
    pub id: String,
    pub title: String,
    pub process_name: String,
    pub pid: u32,
    pub width: u32,
    pub height: u32,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScreenSourcesResponse {
    pub monitors: Vec<MonitorSource>,
    pub windows: Vec<WindowSource>,
}

static CAPTURING_VIDEO: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn list_screen_sources() -> ScreenSourcesResponse {
    let mut monitors_out = Vec::new();
    let mut windows_out = Vec::new();

    // 1. Enumerate Monitors via xcap (Hardware Accelerated)
    if let Ok(monitors) = Monitor::all() {
        for (idx, mon) in monitors.iter().enumerate() {
            let width = mon.width().unwrap_or(1920);
            let height = mon.height().unwrap_or(1080);
            let is_primary = mon.is_primary().unwrap_or(idx == 0);
            let name = if is_primary {
                format!("Monitor {} (Principal)", idx + 1)
            } else {
                format!("Monitor {}", idx + 1)
            };

            let mut thumb_b64 = None;
            if let Ok(rgba_img) = mon.capture_image() {
                let thumb = image::imageops::resize(&rgba_img, 300, 168, FilterType::Nearest);
                let mut buf = Vec::new();
                let mut cursor = Cursor::new(&mut buf);
                if thumb.write_to(&mut cursor, image::ImageFormat::Jpeg).is_ok() {
                    thumb_b64 = Some(format!("data:image/jpeg;base64,{}", BASE64.encode(&buf)));
                }
            }

            monitors_out.push(MonitorSource {
                id: format!("screen:{}", idx),
                name,
                width,
                height,
                is_primary,
                thumbnail: thumb_b64,
            });
        }
    }

    // 2. Enumerate Windows via xcap (Hardware Accelerated)
    if let Ok(windows) = Window::all() {
        let ignore_apps = [
            "Settings",
            "Program Manager",
            "Windows Input Experience",
            "Taskbar",
            "NVIDIA GeForce Overlay",
            "MSCTFIME UI",
            "Default IME",
            "p2sharer",
            "tauri-app",
        ];

        for win in windows.into_iter().take(20) {
            let is_minimized = win.is_minimized().unwrap_or(false);
            if is_minimized {
                continue;
            }

            let title = win.title().unwrap_or_default();
            let title_trim = title.trim().to_string();
            let app_name = win.app_name().unwrap_or_else(|_| "Aplicativo".to_string());

            if title_trim.is_empty() || ignore_apps.iter().any(|&ig| app_name.contains(ig) || title_trim.contains(ig)) {
                continue;
            }

            let width = win.width().unwrap_or(0);
            let height = win.height().unwrap_or(0);

            if width < 250 || height < 200 {
                continue;
            }

            let pid = win.pid().unwrap_or(0);
            let win_id = win.id().map(|id| id.to_string()).unwrap_or_else(|_| pid.to_string());

            let mut thumb_b64 = None;
            if let Ok(rgba_img) = win.capture_image() {
                let thumb = image::imageops::resize(&rgba_img, 300, 168, FilterType::Nearest);
                let mut buf = Vec::new();
                let mut cursor = Cursor::new(&mut buf);
                if thumb.write_to(&mut cursor, image::ImageFormat::Jpeg).is_ok() {
                    thumb_b64 = Some(format!("data:image/jpeg;base64,{}", BASE64.encode(&buf)));
                }
            }

            windows_out.push(WindowSource {
                id: format!("window:{}", win_id),
                title: title_trim,
                process_name: format!("{}.exe", app_name),
                pid,
                width,
                height,
                thumbnail: thumb_b64,
            });
        }
    }

    ScreenSourcesResponse {
        monitors: monitors_out,
        windows: windows_out,
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VideoFramePayload {
    pub jpeg_base64: String,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub fn start_native_screen_capture(
    app: AppHandle,
    source_id: String,
    target_fps: u32,
    target_width: u32,
    target_height: u32,
) -> Result<bool, String> {
    CAPTURING_VIDEO.store(true, Ordering::SeqCst);
    let is_capturing = Arc::new(AtomicBool::new(true));
    let is_capturing_clone = is_capturing.clone();

    let fps = target_fps.max(15).min(120);
    let frame_delay_ms = (1000 / fps).max(8) as u64;

    std::thread::spawn(move || {
        let is_window = source_id.starts_with("window:");
        let raw_id = source_id.split(':').nth(1).unwrap_or("0");

        while is_capturing_clone.load(Ordering::Relaxed) && CAPTURING_VIDEO.load(Ordering::Relaxed) {
            let start_time = std::time::Instant::now();

            let captured_img = if is_window {
                // Find matching window
                Window::all().ok().and_then(|wins| {
                    wins.into_iter()
                        .find(|w| w.id().map(|id| id.to_string()).unwrap_or_default() == raw_id)
                        .and_then(|w| w.capture_image().ok())
                })
            } else {
                // Find matching monitor
                let mon_idx: usize = raw_id.parse().unwrap_or(0);
                Monitor::all().ok().and_then(|mons| {
                    mons.into_iter()
                        .nth(mon_idx)
                        .and_then(|m| m.capture_image().ok())
                })
            };

            if let Some(img) = captured_img {
                let scaled_img = if img.width() != target_width || img.height() != target_height {
                    image::imageops::resize(&img, target_width, target_height, FilterType::Nearest)
                } else {
                    img
                };

                let mut jpeg_bytes = Vec::new();
                let mut cursor = Cursor::new(&mut jpeg_bytes);
                if scaled_img.write_to(&mut cursor, image::ImageFormat::Jpeg).is_ok() {
                    let payload = VideoFramePayload {
                        jpeg_base64: BASE64.encode(&jpeg_bytes),
                        width: target_width,
                        height: target_height,
                    };
                    let _ = app.emit("p2sharer://video-frame", payload);
                }
            }

            let elapsed = start_time.elapsed().as_millis() as u64;
            if elapsed < frame_delay_ms {
                std::thread::sleep(std::time::Duration::from_millis(frame_delay_ms - elapsed));
            }
        }
    });

    Ok(true)
}

#[tauri::command]
pub fn stop_native_screen_capture() -> Result<bool, String> {
    CAPTURING_VIDEO.store(false, Ordering::SeqCst);
    Ok(true)
}
