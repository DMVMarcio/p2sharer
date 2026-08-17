use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::protocol::Message;
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
static WS_SERVER_INITIALIZED: AtomicBool = AtomicBool::new(false);
static FRAME_SENDER: std::sync::OnceLock<broadcast::Sender<Vec<u8>>> = std::sync::OnceLock::new();

fn get_frame_sender() -> &'static broadcast::Sender<Vec<u8>> {
    FRAME_SENDER.get_or_init(|| {
        let (tx, _rx) = broadcast::channel(16);
        tx
    })
}

// Start WebSocket server on 127.0.0.1:49153 to stream binary frames with 0ms latency
fn ensure_ws_server_running() {
    if WS_SERVER_INITIALIZED.swap(true, Ordering::SeqCst) {
        return;
    }

    tokio::spawn(async move {
        let addr = "127.0.0.1:49153";
        if let Ok(listener) = TcpListener::bind(addr).await {
            println!("[Native Video WS] Listening on {}", addr);
            while let Ok((stream, _)) = listener.accept().await {
                let sender = get_frame_sender();
                let mut rx = sender.subscribe();

                tokio::spawn(async move {
                    if let Ok(ws_stream) = tokio_tungstenite::accept_async(stream).await {
                        let (mut write, mut _read) = ws_stream.split();
                        while let Ok(frame_data) = rx.recv().await {
                            if write.send(Message::Binary(frame_data.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                });
            }
        }
    });
}

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
                let mut encoder = JpegEncoder::new_with_quality(&mut cursor, 60);
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
                let mut encoder = JpegEncoder::new_with_quality(&mut cursor, 60);
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

#[cfg(windows)]
fn draw_authentic_cursor(img: &mut image::RgbaImage, origin_x: i32, origin_y: i32) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorInfo, GetIconInfo, DrawIconEx, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, ICONINFO,
    };
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, SelectObject, DeleteDC, DeleteObject,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, HGDIOBJ, HBRUSH,
    };
    use std::ptr::null_mut;

    unsafe {
        let mut ci = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if GetCursorInfo(&mut ci).is_err() || (ci.flags.0 & CURSOR_SHOWING.0 == 0) {
            return;
        }

        let mut ii = ICONINFO::default();
        if GetIconInfo(ci.hCursor, &mut ii).is_err() {
            return;
        }

        let hotspot_x = ii.xHotspot as i32;
        let hotspot_y = ii.yHotspot as i32;

        if !ii.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
        }
        if !ii.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
        }

        let cursor_screen_x = ci.ptScreenPos.x - origin_x - hotspot_x;
        let cursor_screen_y = ci.ptScreenPos.y - origin_y - hotspot_y;

        let cursor_w = 32i32;
        let cursor_h = 32i32;

        let mem_dc = CreateCompatibleDC(HDC::default());
        if mem_dc.is_invalid() {
            return;
        }

        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: cursor_w,
                biHeight: -cursor_h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut bits: *mut std::ffi::c_void = null_mut();
        let hbmp_res = CreateDIBSection(
            mem_dc,
            &bmi,
            DIB_RGB_COLORS,
            &mut bits,
            windows::Win32::Foundation::HANDLE::default(),
            0,
        );

        if let Ok(hbmp) = hbmp_res {
            if !bits.is_null() {
                let old_bmp = SelectObject(mem_dc, HGDIOBJ(hbmp.0));

                let _ = DrawIconEx(
                    mem_dc,
                    0,
                    0,
                    ci.hCursor,
                    cursor_w,
                    cursor_h,
                    0,
                    HBRUSH::default(),
                    DI_NORMAL,
                );

                let pixel_slice = std::slice::from_raw_parts(bits as *const u8, (cursor_w * cursor_h * 4) as usize);

                for cy in 0..cursor_h {
                    for cx in 0..cursor_w {
                        let idx = ((cy * cursor_w + cx) * 4) as usize;
                        let b = pixel_slice[idx];
                        let g = pixel_slice[idx + 1];
                        let r = pixel_slice[idx + 2];
                        let a = pixel_slice[idx + 3];

                        if a > 0 || r > 0 || g > 0 || b > 0 {
                            let target_x = cursor_screen_x + cx;
                            let target_y = cursor_screen_y + cy;

                            if target_x >= 0 && target_x < img.width() as i32 && target_y >= 0 && target_y < img.height() as i32 {
                                let alpha = if a > 0 { a as f32 / 255.0 } else { 1.0 };
                                let existing = img.get_pixel(target_x as u32, target_y as u32);
                                let out_r = (r as f32 * alpha + existing[0] as f32 * (1.0 - alpha)) as u8;
                                let out_g = (g as f32 * alpha + existing[1] as f32 * (1.0 - alpha)) as u8;
                                let out_b = (b as f32 * alpha + existing[2] as f32 * (1.0 - alpha)) as u8;
                                img.put_pixel(target_x as u32, target_y as u32, image::Rgba([out_r, out_g, out_b, 255]));
                            }
                        }
                    }
                }

                let _ = SelectObject(mem_dc, old_bmp);
                let _ = DeleteObject(HGDIOBJ(hbmp.0));
            }
        }

        let _ = DeleteDC(mem_dc);
    }
}

#[tauri::command]
pub fn start_native_screen_capture(
    source_id: String,
    target_fps: u32,
    target_width: u32,
    target_height: u32,
    capture_mouse: Option<bool>,
    quality: Option<u8>,
) -> Result<bool, String> {
    ensure_ws_server_running();
    CAPTURING_VIDEO.store(true, Ordering::SeqCst);
    let is_capturing = Arc::new(AtomicBool::new(true));
    let is_capturing_clone = is_capturing.clone();

    let fps = target_fps.max(15).min(120);
    let frame_delay_ms = (1000 / fps).max(6) as u64;
    let should_draw_mouse = capture_mouse.unwrap_or(true);
    let jpeg_quality = quality.unwrap_or(80).max(50).min(90);

    let sender = get_frame_sender().clone();

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

            let captured_img = if is_window {
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
                                    draw_authentic_cursor(&mut img, origin_x, origin_y);
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
                                draw_authentic_cursor(&mut img, origin_x, origin_y);
                            }
                            img
                        })
                    })
                } else {
                    None
                }
            };

            if let Some(img) = captured_img {
                // Resize if needed
                let scaled_img = if img.width() != target_width || img.height() != target_height {
                    image::imageops::resize(&img, target_width, target_height, FilterType::Nearest)
                } else {
                    img
                };

                let mut jpeg_bytes = Vec::with_capacity(90_000);
                let mut cursor = Cursor::new(&mut jpeg_bytes);
                let mut encoder = JpegEncoder::new_with_quality(&mut cursor, jpeg_quality);
                if encoder.encode_image(&scaled_img).is_ok() {
                    let _ = sender.send(jpeg_bytes);
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
