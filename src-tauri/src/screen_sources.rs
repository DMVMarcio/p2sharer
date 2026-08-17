use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
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
                let mut encoder = JpegEncoder::new_with_quality(&mut cursor, 65);
                if encoder.encode_image(&thumb).is_ok() {
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

        for win in windows.into_iter().take(30) {
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
                let mut encoder = JpegEncoder::new_with_quality(&mut cursor, 65);
                if encoder.encode_image(&thumb).is_ok() {
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

#[cfg(windows)]
fn draw_cursor_overlay(img: &mut image::RgbaImage, origin_x: i32, origin_y: i32) {
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorInfo, CURSORINFO, CURSOR_SHOWING};

    unsafe {
        let mut ci = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if GetCursorInfo(&mut ci).is_ok() && (ci.flags.0 & CURSOR_SHOWING.0 != 0) {
            let cx = ci.ptScreenPos.x - origin_x;
            let cy = ci.ptScreenPos.y - origin_y;

            // Draw clean high-visibility cursor arrow
            let arrow_pixels: &[(i32, i32, [u8; 4])] = &[
                // Outer black border
                (-1, -1, [0, 0, 0, 255]), (0, -1, [0, 0, 0, 255]), (1, -1, [0, 0, 0, 255]),
                (-1, 0, [0, 0, 0, 255]), (1, 1, [0, 0, 0, 255]), (2, 2, [0, 0, 0, 255]),
                (3, 3, [0, 0, 0, 255]), (4, 4, [0, 0, 0, 255]), (5, 5, [0, 0, 0, 255]),
                (6, 6, [0, 0, 0, 255]), (7, 7, [0, 0, 0, 255]), (8, 8, [0, 0, 0, 255]),
                (9, 9, [0, 0, 0, 255]), (10, 10, [0, 0, 0, 255]), (11, 11, [0, 0, 0, 255]),
                // Inner white body
                (0, 0, [255, 255, 255, 255]), (0, 1, [255, 255, 255, 255]), (0, 2, [255, 255, 255, 255]),
                (0, 3, [255, 255, 255, 255]), (0, 4, [255, 255, 255, 255]), (0, 5, [255, 255, 255, 255]),
                (0, 6, [255, 255, 255, 255]), (0, 7, [255, 255, 255, 255]), (0, 8, [255, 255, 255, 255]),
                (0, 9, [255, 255, 255, 255]), (0, 10, [255, 255, 255, 255]),
                (1, 2, [255, 255, 255, 255]), (1, 3, [255, 255, 255, 255]), (1, 4, [255, 255, 255, 255]),
                (1, 5, [255, 255, 255, 255]), (1, 6, [255, 255, 255, 255]), (1, 7, [255, 255, 255, 255]),
                (2, 3, [255, 255, 255, 255]), (2, 4, [255, 255, 255, 255]), (2, 5, [255, 255, 255, 255]),
                (2, 6, [255, 255, 255, 255]), (3, 4, [255, 255, 255, 255]), (3, 5, [255, 255, 255, 255]),
                (4, 5, [255, 255, 255, 255]), (4, 6, [255, 255, 255, 255]), (5, 6, [255, 255, 255, 255]),
                (6, 7, [255, 255, 255, 255]), (7, 8, [255, 255, 255, 255]), (8, 9, [255, 255, 255, 255]),
                (9, 10, [255, 255, 255, 255]), (10, 11, [255, 255, 255, 255]),
            ];

            for &(dx, dy, color) in arrow_pixels {
                let px = cx + dx;
                let py = cy + dy;
                if px >= 0 && px < img.width() as i32 && py >= 0 && py < img.height() as i32 {
                    img.put_pixel(px as u32, py as u32, image::Rgba(color));
                }
            }
        }
    }
}

#[tauri::command]
pub fn start_native_screen_capture(
    app: AppHandle,
    source_id: String,
    target_fps: u32,
    target_width: u32,
    target_height: u32,
    capture_mouse: Option<bool>,
    quality: Option<u8>,
) -> Result<bool, String> {
    CAPTURING_VIDEO.store(true, Ordering::SeqCst);
    let is_capturing = Arc::new(AtomicBool::new(true));
    let is_capturing_clone = is_capturing.clone();

    let fps = target_fps.max(15).min(120);
    let frame_delay_ms = (1000 / fps).max(8) as u64;
    let should_draw_mouse = capture_mouse.unwrap_or(true);
    let jpeg_quality = quality.unwrap_or(90).max(60).min(98);

    std::thread::spawn(move || {
        let is_window = source_id.starts_with("window:");
        let raw_id = source_id.split(':').nth(1).unwrap_or("0");

        let target_mon_idx: usize = if !is_window {
            raw_id.parse().unwrap_or(0)
        } else {
            0
        };

        let target_win_id = raw_id.to_string();

        while is_capturing_clone.load(Ordering::Relaxed) && CAPTURING_VIDEO.load(Ordering::Relaxed) {
            let start_time = std::time::Instant::now();

            let mut captured_img = if is_window {
                if let Ok(windows) = Window::all() {
                    windows
                        .into_iter()
                        .find(|w| w.id().map(|id| id.to_string()).unwrap_or_default() == target_win_id)
                        .and_then(|w| {
                            let origin_x = w.x().unwrap_or(0);
                            let origin_y = w.y().unwrap_or(0);
                            w.capture_image().ok().map(|mut img| {
                                #[cfg(windows)]
                                if should_draw_mouse {
                                    draw_cursor_overlay(&mut img, origin_x, origin_y);
                                }
                                img
                            })
                        })
                } else {
                    None
                }
            } else {
                if let Ok(monitors) = Monitor::all() {
                    monitors.into_iter().nth(target_mon_idx).and_then(|m| {
                        let origin_x = m.x().unwrap_or(0);
                        let origin_y = m.y().unwrap_or(0);
                        m.capture_image().ok().map(|mut img| {
                            #[cfg(windows)]
                            if should_draw_mouse {
                                draw_cursor_overlay(&mut img, origin_x, origin_y);
                            }
                            img
                        })
                    })
                } else {
                    None
                }
            };

            if let Some(mut img) = captured_img.take() {
                let scaled_img = if img.width() != target_width || img.height() != target_height {
                    image::imageops::resize(&img, target_width, target_height, FilterType::Nearest)
                } else {
                    img
                };

                let mut jpeg_bytes = Vec::new();
                let mut cursor = Cursor::new(&mut jpeg_bytes);
                let mut encoder = JpegEncoder::new_with_quality(&mut cursor, jpeg_quality);
                if encoder.encode_image(&scaled_img).is_ok() {
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
