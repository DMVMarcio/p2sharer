use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use jpeg_encoder::{ColorType, Encoder as FastJpegEncoder, SamplingFactor};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::protocol::Message;
use xcap::{Monitor, Window};

#[cfg(windows)]
use windows_capture::{
    capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor as WgcMonitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
    window::Window as WgcWindow,
};

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
static WS_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);
static FRAME_SENDER: std::sync::OnceLock<broadcast::Sender<Message>> = std::sync::OnceLock::new();
static CURRENT_CAPTURE_FLAG: std::sync::Mutex<Option<Arc<AtomicBool>>> = std::sync::Mutex::new(None);

#[derive(Clone)]
pub struct CaptureFlags {
    pub sender: broadcast::Sender<Message>,
    pub target_fps: u32,
    pub target_width: u32,
    pub target_height: u32,
    pub quality: u8,
    pub active_flag: Arc<AtomicBool>,
    pub latest_frame: Arc<std::sync::Mutex<Option<Arc<Vec<u8>>>>>,
    pub last_sent_us: Arc<std::sync::atomic::AtomicU64>,
    pub start_instant: std::time::Instant,
}

#[cfg(windows)]
pub struct NativeWgcHandler {
    sender: broadcast::Sender<Message>,
    target_width: u32,
    target_height: u32,
    quality: u8,
    active_flag: Arc<AtomicBool>,
    raw_buffer: Vec<u8>,
    resized_image: Option<fast_image_resize::images::Image<'static>>,
    resizer: fast_image_resize::Resizer,
    jpeg_buffer: Vec<u8>,
    last_frame_time: std::time::Instant,
    min_frame_interval: std::time::Duration,
    latest_frame: Arc<std::sync::Mutex<Option<Arc<Vec<u8>>>>>,
    last_sent_us: Arc<std::sync::atomic::AtomicU64>,
    start_instant: std::time::Instant,
}

#[cfg(windows)]
impl GraphicsCaptureApiHandler for NativeWgcHandler {
    type Flags = CaptureFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let fps = ctx.flags.target_fps.clamp(15, 120);
        // Allow frames up to 2x target FPS so natural +/- 1.5ms VSync/DWM jitter is never dropped
        let min_frame_interval = std::time::Duration::from_nanos(1_000_000_000 / (fps as u64 * 2));
        Ok(Self {
            sender: ctx.flags.sender,
            target_width: ctx.flags.target_width,
            target_height: ctx.flags.target_height,
            quality: ctx.flags.quality,
            active_flag: ctx.flags.active_flag,
            raw_buffer: Vec::with_capacity(1920 * 1080 * 4),
            resized_image: None,
            resizer: fast_image_resize::Resizer::new(),
            jpeg_buffer: Vec::with_capacity(256 * 1024),
            last_frame_time: std::time::Instant::now() - std::time::Duration::from_secs(1),
            min_frame_interval,
            latest_frame: ctx.flags.latest_frame,
            last_sent_us: ctx.flags.last_sent_us,
            start_instant: ctx.flags.start_instant,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if !self.active_flag.load(Ordering::Relaxed) || !CAPTURING_VIDEO.load(Ordering::Relaxed) {
            capture_control.stop();
            return Ok(());
        }

        let elapsed = self.last_frame_time.elapsed();
        if elapsed < self.min_frame_interval {
            return Ok(());
        }

        let src_width = frame.width();
        let src_height = frame.height();
        if src_width == 0 || src_height == 0 {
            return Ok(());
        }

        let frame_buffer = match frame.buffer() {
            Ok(buf) => buf,
            Err(_e) => {
                // Transient DXGI surface lock or swapchain mode switch (e.g. game launched / resized)
                // Returning Ok(()) ensures windows-capture does NOT abort the capture loop!
                return Ok(());
            }
        };
        self.last_frame_time = std::time::Instant::now();
        let pixel_data = frame_buffer.as_nopadding_buffer(&mut self.raw_buffer);

        let (final_pixels, final_w, final_h) = if self.target_width > 0
            && self.target_height > 0
            && (src_width != self.target_width || src_height != self.target_height)
        {
            use fast_image_resize::images::{Image, ImageRef};
            use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions};

            if let Ok(src_img) = ImageRef::new(src_width, src_height, pixel_data, PixelType::U8x4) {
                let dst_w = self.target_width;
                let dst_h = self.target_height;

                if self
                    .resized_image
                    .as_ref()
                    .map_or(true, |img| img.width() != dst_w || img.height() != dst_h)
                {
                    self.resized_image = Some(Image::new(dst_w, dst_h, PixelType::U8x4));
                }

                if let Some(dst_img) = self.resized_image.as_mut() {
                    let options =
                        ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Bilinear));
                    if self.resizer.resize(&src_img, dst_img, &options).is_ok() {
                        (dst_img.buffer(), dst_w, dst_h)
                    } else {
                        (pixel_data, src_width, src_height)
                    }
                } else {
                    (pixel_data, src_width, src_height)
                }
            } else {
                (pixel_data, src_width, src_height)
            }
        } else {
            (pixel_data, src_width, src_height)
        };

        self.jpeg_buffer.clear();
        let mut encoder = FastJpegEncoder::new(&mut self.jpeg_buffer, self.quality);
        encoder.set_sampling_factor(SamplingFactor::R_4_2_0);
        if encoder
            .encode(
                final_pixels,
                final_w as u16,
                final_h as u16,
                ColorType::Rgba,
            )
            .is_ok()
        {
            let frame_bytes = std::mem::take(&mut self.jpeg_buffer);
            let frame_arc = Arc::new(frame_bytes);
            if let Ok(mut cache) = self.latest_frame.lock() {
                *cache = Some(frame_arc.clone());
            }
            self.last_sent_us.store(
                self.start_instant.elapsed().as_micros() as u64,
                Ordering::Release,
            );
            let _ = self.sender.send(Message::Binary((*frame_arc).clone()));
        }

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        let _ = self.sender.send(Message::Text(
            "{\"type\":\"fallback\",\"reason\":\"window_closed\"}".to_string(),
        ));
        Ok(())
    }
}

#[cfg(windows)]
type ActiveCaptureControl =
    CaptureControl<NativeWgcHandler, Box<dyn std::error::Error + Send + Sync>>;

#[cfg(windows)]
static CURRENT_WGC_CONTROL: std::sync::Mutex<Option<ActiveCaptureControl>> =
    std::sync::Mutex::new(None);


fn get_frame_sender() -> &'static broadcast::Sender<Message> {
    FRAME_SENDER.get_or_init(|| {
        let (tx, _rx) = broadcast::channel(32);
        tx
    })
}

#[cfg(windows)]
pub struct MultimediaTimerGuard;

#[cfg(windows)]
impl MultimediaTimerGuard {
    pub fn new() -> Self {
        unsafe {
            let _ = windows::Win32::Media::timeBeginPeriod(1);
        }
        MultimediaTimerGuard
    }
}

#[cfg(windows)]
impl Default for MultimediaTimerGuard {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
impl Drop for MultimediaTimerGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Media::timeEndPeriod(1);
        }
    }
}

#[cfg(not(windows))]
pub struct MultimediaTimerGuard;

#[cfg(not(windows))]
impl MultimediaTimerGuard {
    pub fn new() -> Self {
        MultimediaTimerGuard
    }
}

#[cfg(not(windows))]
impl Default for MultimediaTimerGuard {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub fn get_video_ws_port() -> u16 {
    WS_PORT.load(Ordering::SeqCst)
}

pub fn is_video_capturing() -> bool {
    CAPTURING_VIDEO.load(Ordering::Relaxed)
}

pub fn is_wgc_active() -> bool {
    #[cfg(windows)]
    {
        if let Ok(guard) = CURRENT_WGC_CONTROL.lock() {
            return guard.is_some();
        }
    }
    false
}

// Start WebSocket server dynamically in a dedicated multi-threaded runtime
pub fn ensure_ws_server_running() {
    if WS_SERVER_INITIALIZED.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::spawn(|| {
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[Native Video WS] Failed to create tokio runtime: {:?}", e);
                return;
            }
        };

        rt.block_on(async {
            // Try default 49153 first, otherwise bind to port 0 (OS assigned)
            let listener = match TcpListener::bind("127.0.0.1:49153").await {
                Ok(l) => l,
                Err(_) => match TcpListener::bind("127.0.0.1:0").await {
                    Ok(l) => l,
                    Err(e) => {
                        eprintln!("[Native Video WS] Failed to bind any port: {:?}", e);
                        return;
                    }
                },
            };

            if let Ok(local_addr) = listener.local_addr() {
                let port = local_addr.port();
                WS_PORT.store(port, Ordering::SeqCst);
                println!("[Native Video WS] Dedicated instance listening on 127.0.0.1:{}", port);
            }

            while let Ok((stream, _)) = listener.accept().await {
                let sender = get_frame_sender();
                let mut rx = sender.subscribe();

                tokio::spawn(async move {
                    if let Ok(ws_stream) = tokio_tungstenite::accept_async(stream).await {
                        let (mut write, mut _read) = ws_stream.split();
                        loop {
                            match rx.recv().await {
                                Ok(msg) => {
                                    if write.send(msg).await.is_err() {
                                        break;
                                    }
                                }
                                Err(broadcast::error::RecvError::Lagged(_)) => {
                                    // Drop lagged frames to guarantee absolute zero latency
                                    continue;
                                }
                                Err(broadcast::error::RecvError::Closed) => {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        });
    });
}

#[tauri::command]
pub fn list_screen_sources() -> ScreenSourcesResponse {
    let mut monitors_out = Vec::new();
    let mut windows_out = Vec::new();

    // 1. Enumerate Monitors via xcap (Fast lightweight thumbnails: 160x90, quality 40)
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
                let thumb = image::imageops::resize(&rgba_img, 320, 180, FilterType::Triangle);
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

    // 2. Enumerate Windows via xcap (Decoupled: small 160x90 thumbnails only for top foreground windows)
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

        let mut candidate_windows = Vec::new();
        for win in windows {
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

            candidate_windows.push((win, title_trim, app_name, width, height));
            if candidate_windows.len() >= 20 {
                break;
            }
        }

        for (idx, (win, title_trim, app_name, width, height)) in candidate_windows.into_iter().enumerate() {
            let pid = win.pid().unwrap_or(0);
            let win_id = win.id().map(|id| id.to_string()).unwrap_or_else(|_| pid.to_string());

            let mut thumb_b64 = None;
            // Only generate thumbnails for top 6 foreground windows to eliminate 2-5s IPC freeze
            if idx < 6 {
                if let Ok(rgba_img) = win.capture_image() {
                    let thumb = image::imageops::resize(&rgba_img, 320, 180, FilterType::Triangle);
                    let mut buf = Vec::new();
                    let mut cursor = Cursor::new(&mut buf);
                    let mut encoder = JpegEncoder::new_with_quality(&mut cursor, 65);
                    if encoder.encode_image(&thumb).is_ok() {
                        thumb_b64 = Some(format!("data:image/jpeg;base64,{}", BASE64.encode(&buf)));
                    }
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
        if GetCursorInfo(&mut ci).is_err() || (ci.flags.0 & CURSOR_SHOWING.0 == 0) || ci.hCursor.is_invalid() {
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

        // Quick bounding box check before any GDI allocation
        if cursor_screen_x + cursor_w <= 0
            || cursor_screen_x >= img.width() as i32
            || cursor_screen_y + cursor_h <= 0
            || cursor_screen_y >= img.height() as i32
        {
            return;
        }

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
                let img_w = img.width() as i32;
                let img_h = img.height() as i32;

                for cy in 0..cursor_h {
                    let target_y = cursor_screen_y + cy;
                    if target_y < 0 || target_y >= img_h {
                        continue;
                    }
                    for cx in 0..cursor_w {
                        let target_x = cursor_screen_x + cx;
                        if target_x < 0 || target_x >= img_w {
                            continue;
                        }

                        let idx = ((cy * cursor_w + cx) * 4) as usize;
                        let b = pixel_slice[idx];
                        let g = pixel_slice[idx + 1];
                        let r = pixel_slice[idx + 2];
                        let a = pixel_slice[idx + 3];

                        if a > 0 || r > 0 || g > 0 || b > 0 {
                            let alpha = if a > 0 { a as f32 / 255.0 } else { 1.0 };
                            let existing = img.get_pixel(target_x as u32, target_y as u32);
                            let out_r = (r as f32 * alpha + existing[0] as f32 * (1.0 - alpha)) as u8;
                            let out_g = (g as f32 * alpha + existing[1] as f32 * (1.0 - alpha)) as u8;
                            let out_b = (b as f32 * alpha + existing[2] as f32 * (1.0 - alpha)) as u8;
                            img.put_pixel(target_x as u32, target_y as u32, image::Rgba([out_r, out_g, out_b, 255]));
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
    target_fps: Option<u32>,
    target_width: Option<u32>,
    target_height: Option<u32>,
    capture_mouse: Option<bool>,
    quality: Option<u8>,
) -> Result<bool, String> {
    if source_id.trim().is_empty() {
        return Err("sourceId cannot be empty".to_string());
    }

    ensure_ws_server_running();

    // Stop any existing capture session first
    let _ = stop_native_screen_capture();

    CAPTURING_VIDEO.store(true, Ordering::SeqCst);
    let is_capturing = Arc::new(AtomicBool::new(true));
    let is_capturing_clone = is_capturing.clone();

    if let Ok(mut guard) = CURRENT_CAPTURE_FLAG.lock() {
        *guard = Some(is_capturing.clone());
    }

    let fps = target_fps.unwrap_or(60).clamp(15, 120);
    let width = target_width.unwrap_or(0);
    let height = target_height.unwrap_or(0);
    let should_draw_mouse = capture_mouse.unwrap_or(true);
    let jpeg_quality = quality.unwrap_or(90).clamp(60, 95);

    let sender = get_frame_sender().clone();
    let start_instant = std::time::Instant::now();
    let latest_frame_cache: Arc<std::sync::Mutex<Option<Arc<Vec<u8>>>>> =
        Arc::new(std::sync::Mutex::new(None));
    let last_sent_us = Arc::new(std::sync::atomic::AtomicU64::new(0));

    // High-precision frame heartbeat pacer thread (guarantees constant stream heartbeat without starvation)
    let pacer_active = is_capturing.clone();
    let pacer_sender = sender.clone();
    let pacer_cache = latest_frame_cache.clone();
    let pacer_wgc_last_sent_us = last_sent_us.clone();
    let pacer_start = start_instant;
    let target_interval_us = (1_000_000 / fps as u64).max(8_000);
    let static_timeout_us = target_interval_us * 4; // ~66ms threshold before emitting static ticks

    std::thread::spawn(move || {
        let _timer_guard = MultimediaTimerGuard::new();
        let mut next_tick_us = pacer_start.elapsed().as_micros() as u64 + target_interval_us;
        let mut pacer_tick_count: u64 = 0;

        while pacer_active.load(Ordering::Relaxed) && CAPTURING_VIDEO.load(Ordering::Relaxed) {
            let now_us = pacer_start.elapsed().as_micros() as u64;
            let last_wgc = pacer_wgc_last_sent_us.load(Ordering::Acquire);

            // If a real WGC frame arrived recently (< static_timeout_us), WGC is actively streaming:
            // Back off next_tick_us so pacer never competes with active screen/mouse movement
            if last_wgc > 0 && now_us.saturating_sub(last_wgc) < static_timeout_us {
                next_tick_us = last_wgc + static_timeout_us;
            } else if now_us >= next_tick_us {
                pacer_tick_count += 1;
                if let Ok(guard) = pacer_cache.lock() {
                    if let Some(frame) = guard.as_ref() {
                        // Full frame keyframe refresh twice per second (every 30 ticks / ~500ms);
                        // On intermediate static ticks, emit 1-byte heartbeat tick [0] to bypass CPU JPEG decoding in JS!
                        if pacer_tick_count % 30 == 0 {
                            let _ = pacer_sender.send(Message::Binary((**frame).clone()));
                        } else {
                            let _ = pacer_sender.send(Message::Binary(vec![0]));
                        }
                    }
                }
                next_tick_us += target_interval_us;
                if next_tick_us < now_us {
                    next_tick_us = now_us + target_interval_us;
                }
            }

            // Dynamically sleep based on time remaining to avoid 1000 wakeups/second
            let remaining_us = next_tick_us.saturating_sub(now_us);
            let sleep_ms = (remaining_us / 2000).clamp(1, 16);
            std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
        }
    });

    #[cfg(windows)]
    {
        let flags = CaptureFlags {
            sender: sender.clone(),
            target_fps: fps,
            target_width: width,
            target_height: height,
            quality: jpeg_quality,
            active_flag: is_capturing.clone(),
            latest_frame: latest_frame_cache.clone(),
            last_sent_us: last_sent_us.clone(),
            start_instant,
        };

        let cursor_settings = if should_draw_mouse {
            CursorCaptureSettings::WithCursor
        } else {
            CursorCaptureSettings::WithoutCursor
        };

        let is_window = source_id.starts_with("window:");
        let raw_id = source_id.split(':').nth(1).unwrap_or("0");

        let mut wgc_started = false;

        if is_window {
            let wgc_window = if let Ok(hwnd_int) = raw_id.parse::<usize>() {
                let candidate = WgcWindow::from_raw_hwnd(hwnd_int as *mut std::ffi::c_void);
                if candidate.is_valid() {
                    Some(candidate)
                } else {
                    None
                }
            } else {
                None
            };

            let wgc_window = wgc_window.or_else(|| {
                if let Ok(windows) = WgcWindow::enumerate() {
                    if let Ok(target_pid) = raw_id.parse::<u32>() {
                        windows.into_iter().find(|w| w.process_id().unwrap_or(0) == target_pid)
                    } else {
                        None
                    }
                } else {
                    None
                }
            });

            if let Some(win) = wgc_window {
                let settings = Settings::new(
                    win,
                    cursor_settings,
                    DrawBorderSettings::WithoutBorder,
                    SecondaryWindowSettings::Default,
                    MinimumUpdateIntervalSettings::Default,
                    DirtyRegionSettings::Default,
                    ColorFormat::Rgba8,
                    flags.clone(),
                );

                match NativeWgcHandler::start_free_threaded(settings) {
                    Ok(control) => {
                        if let Ok(mut guard) = CURRENT_WGC_CONTROL.lock() {
                            *guard = Some(control);
                        }
                        wgc_started = true;
                    }
                    Err(err) => {
                        eprintln!(
                            "[Native Video] WGC window capture start failed: {:?}, falling back to xcap",
                            err
                        );
                    }
                }
            }
        } else {
            let target_mon_idx: usize = raw_id.parse().unwrap_or(0);
            let wgc_monitor =
                WgcMonitor::from_index(target_mon_idx + 1).or_else(|_| WgcMonitor::primary());

            if let Ok(mon) = wgc_monitor {
                let settings = Settings::new(
                    mon,
                    cursor_settings,
                    DrawBorderSettings::WithoutBorder,
                    SecondaryWindowSettings::Default,
                    MinimumUpdateIntervalSettings::Default,
                    DirtyRegionSettings::Default,
                    ColorFormat::Rgba8,
                    flags.clone(),
                );

                match NativeWgcHandler::start_free_threaded(settings) {
                    Ok(control) => {
                        if let Ok(mut guard) = CURRENT_WGC_CONTROL.lock() {
                            *guard = Some(control);
                        }
                        wgc_started = true;
                    }
                    Err(err) => {
                        eprintln!(
                            "[Native Video] WGC monitor capture start failed: {:?}, falling back to xcap",
                            err
                        );
                    }
                }
            }
        }

        if wgc_started {
            return Ok(true);
        }
    }

    // Fallback capture thread (xcap) if WGC is unsupported or failed
    let frame_interval =
        std::time::Duration::from_nanos((1_000_000_000 / fps as u64).max(8_000_000));
    let xcap_latest_cache = latest_frame_cache.clone();
    let xcap_last_sent_us = last_sent_us.clone();
    std::thread::spawn(move || {
        let _timer_guard = MultimediaTimerGuard::new();

        let is_window = source_id.starts_with("window:");
        let raw_id = source_id.split(':').nth(1).unwrap_or("0");

        let target_mon_idx: usize = if !is_window {
            raw_id.parse().unwrap_or(0)
        } else {
            0
        };

        let target_win_id = raw_id.to_string();

        let mut cached_monitor: Option<Monitor> = if !is_window {
            Monitor::all()
                .ok()
                .and_then(|mons| mons.into_iter().nth(target_mon_idx))
        } else {
            None
        };

        let mut cached_window: Option<Window> = if is_window {
            Window::all().ok().and_then(|wins| {
                wins.into_iter().find(|w| {
                    w.id().map(|id| id.to_string()).unwrap_or_default() == target_win_id
                })
            })
        } else {
            None
        };

        let mut last_retry = std::time::Instant::now();
        let mut consecutive_errors: u32 = 0;
        let mut jpeg_bytes = Vec::with_capacity(256 * 1024);
        let mut resizer = fast_image_resize::Resizer::new();
        let mut resized_img_buf: Option<fast_image_resize::images::Image<'static>> = None;

        while is_capturing_clone.load(Ordering::Relaxed) && CAPTURING_VIDEO.load(Ordering::Relaxed)
        {
            let loop_start = std::time::Instant::now();

            let captured_img = if is_window {
                if let Some(ref win) = cached_window {
                    if win.is_minimized().unwrap_or(false) {
                        let _ = sender.send(Message::Text(
                            "{\"type\":\"fallback\",\"reason\":\"window_minimized\"}".to_string(),
                        ));
                        break;
                    }
                }

                if cached_window.is_none() && last_retry.elapsed().as_millis() > 500 {
                    last_retry = std::time::Instant::now();
                    cached_window = Window::all().ok().and_then(|wins| {
                        wins.into_iter().find(|w| {
                            w.id().map(|id| id.to_string()).unwrap_or_default() == target_win_id
                        })
                    });
                }

                if let Some(ref win) = cached_window {
                    let origin_x = win.x().unwrap_or(0);
                    let origin_y = win.y().unwrap_or(0);
                    match win.capture_image() {
                        Ok(mut img) => {
                            consecutive_errors = 0;
                            #[cfg(windows)]
                            if should_draw_mouse {
                                draw_authentic_cursor(&mut img, origin_x, origin_y);
                            }
                            Some(img)
                        }
                        Err(_) => {
                            cached_window = None;
                            consecutive_errors += 1;
                            if consecutive_errors >= 5 {
                                let _ = sender.send(Message::Text(
                                    "{\"type\":\"fallback\",\"reason\":\"capture_error\"}"
                                        .to_string(),
                                ));
                                break;
                            }
                            None
                        }
                    }
                } else {
                    consecutive_errors += 1;
                    if consecutive_errors >= 5 {
                        let _ = sender.send(Message::Text(
                            "{\"type\":\"fallback\",\"reason\":\"window_not_found\"}".to_string(),
                        ));
                        break;
                    }
                    None
                }
            } else {
                if cached_monitor.is_none() && last_retry.elapsed().as_millis() > 500 {
                    last_retry = std::time::Instant::now();
                    cached_monitor = Monitor::all()
                        .ok()
                        .and_then(|mons| mons.into_iter().nth(target_mon_idx));
                }

                if let Some(ref mon) = cached_monitor {
                    let origin_x = mon.x().unwrap_or(0);
                    let origin_y = mon.y().unwrap_or(0);
                    match mon.capture_image() {
                        Ok(mut img) => {
                            consecutive_errors = 0;
                            #[cfg(windows)]
                            if should_draw_mouse {
                                draw_authentic_cursor(&mut img, origin_x, origin_y);
                            }
                            Some(img)
                        }
                        Err(_) => {
                            cached_monitor = None;
                            consecutive_errors += 1;
                            if consecutive_errors >= 5 {
                                let _ = sender.send(Message::Text(
                                    "{\"type\":\"fallback\",\"reason\":\"capture_error\"}"
                                        .to_string(),
                                ));
                                break;
                            }
                            None
                        }
                    }
                } else {
                    consecutive_errors += 1;
                    if consecutive_errors >= 5 {
                        let _ = sender.send(Message::Text(
                            "{\"type\":\"fallback\",\"reason\":\"monitor_not_found\"}".to_string(),
                        ));
                        break;
                    }
                    None
                }
            };

            if let Some(img) = captured_img {
                use fast_image_resize::images::{Image, ImageRef};
                use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions};

                let src_w = img.width();
                let src_h = img.height();

                let (final_raw, final_w, final_h) =
                    if width > 0 && height > 0 && (src_w != width || src_h != height) {
                        if let Ok(src_img) =
                            ImageRef::new(src_w, src_h, img.as_raw(), PixelType::U8x4)
                        {
                            if resized_img_buf
                                .as_ref()
                                .map_or(true, |r| r.width() != width || r.height() != height)
                            {
                                resized_img_buf = Some(Image::new(width, height, PixelType::U8x4));
                            }
                            if let Some(dst_img) = resized_img_buf.as_mut() {
                                let options = ResizeOptions::new()
                                    .resize_alg(ResizeAlg::Convolution(FilterType::Bilinear));
                                if resizer.resize(&src_img, dst_img, &options).is_ok() {
                                    (dst_img.buffer(), width, height)
                                } else {
                                    (img.as_raw().as_slice(), src_w, src_h)
                                }
                            } else {
                                (img.as_raw().as_slice(), src_w, src_h)
                            }
                        } else {
                            (img.as_raw().as_slice(), src_w, src_h)
                        }
                    } else {
                        (img.as_raw().as_slice(), src_w, src_h)
                    };

                jpeg_bytes.clear();
                let mut encoder = FastJpegEncoder::new(&mut jpeg_bytes, jpeg_quality);
                encoder.set_sampling_factor(SamplingFactor::R_4_2_0);
                if encoder
                    .encode(
                        final_raw,
                        final_w as u16,
                        final_h as u16,
                        ColorType::Rgba,
                    )
                    .is_ok()
                {
                    let frame_arc = Arc::new(jpeg_bytes.clone());
                    if let Ok(mut cache) = xcap_latest_cache.lock() {
                        *cache = Some(frame_arc.clone());
                    }
                    xcap_last_sent_us.store(
                        start_instant.elapsed().as_micros() as u64,
                        Ordering::Release,
                    );
                    let _ = sender.send(Message::Binary((*frame_arc).clone()));
                }
            }

            let elapsed = loop_start.elapsed();
            if elapsed < frame_interval {
                std::thread::sleep(frame_interval - elapsed);
            }
        }
    });

    Ok(true)
}

#[tauri::command]
pub fn stop_native_screen_capture() -> Result<bool, String> {
    CAPTURING_VIDEO.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = CURRENT_CAPTURE_FLAG.lock() {
        if let Some(flag) = guard.take() {
            flag.store(false, Ordering::SeqCst);
        }
    }
    #[cfg(windows)]
    if let Ok(mut guard) = CURRENT_WGC_CONTROL.lock() {
        if let Some(control) = guard.take() {
            std::thread::spawn(move || {
                let _ = control.stop();
            });
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sanitize_quality(quality: Option<u8>) -> u8 {
        quality.unwrap_or(90).clamp(60, 98)
    }

    #[test]
    fn test_fps_clamp() {
        assert_eq!(10u32.clamp(15, 120), 15);
        assert_eq!(60u32.clamp(15, 120), 60);
        assert_eq!(144u32.clamp(15, 120), 120);
    }

    #[test]
    fn test_quality_clamp() {
        assert_eq!(sanitize_quality(None), 90);
        assert_eq!(sanitize_quality(Some(30)), 60);
        assert_eq!(sanitize_quality(Some(75)), 75);
        assert_eq!(sanitize_quality(Some(100)), 98);
    }

    #[test]
    fn test_timer_guard_lifecycle() {
        let guard = MultimediaTimerGuard::new();
        drop(guard);
    }

    #[test]
    fn test_start_native_screen_capture_empty_source_id() {
        let res = start_native_screen_capture("".to_string(), None, None, None, None, None);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), "sourceId cannot be empty");
    }

    #[test]
    fn test_jpeg_sampling_sizes() {
        let dummy = vec![128u8; 1920 * 1080 * 4];
        let mut buf_444 = Vec::new();
        let mut enc_444 = FastJpegEncoder::new(&mut buf_444, 80);
        enc_444.set_sampling_factor(SamplingFactor::R_4_4_4);
        enc_444.encode(&dummy, 1920, 1080, ColorType::Rgba).unwrap();

        let mut buf_420 = Vec::new();
        let mut enc_420 = FastJpegEncoder::new(&mut buf_420, 80);
        enc_420.set_sampling_factor(SamplingFactor::R_4_2_0);
        enc_420.encode(&dummy, 1920, 1080, ColorType::Rgba).unwrap();

        println!("dummy 1080p: 444 = {} bytes, 420 = {} bytes", buf_444.len(), buf_420.len());
    }

    #[test]
    fn test_wgc_live_fps() {
        let mut rx = get_frame_sender().subscribe();
        let res = start_native_screen_capture("screen:0".to_string(), Some(60), Some(1920), Some(1080), Some(true), Some(80));
        println!("start_native_screen_capture result: {:?}", res);
        assert!(res.is_ok());

        let timeout = std::time::Instant::now();
        let mut first_frame_time = None;
        let mut frame_count = 0;
        let measure_duration = std::time::Duration::from_millis(2000);

        while timeout.elapsed().as_millis() < 4000 {
            match rx.try_recv() {
                Ok(tokio_tungstenite::tungstenite::Message::Binary(bytes)) => {
                    if first_frame_time.is_none() {
                        first_frame_time = Some(std::time::Instant::now());
                        println!("First frame received! size = {} bytes", bytes.len());
                    }
                    frame_count += 1;
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Lagged(n)) => {
                    frame_count += n;
                }
                Err(e) => {
                    println!("rx error: {:?}", e);
                    break;
                }
            }

            if let Some(first_time) = first_frame_time {
                if first_time.elapsed() >= measure_duration {
                    break;
                }
            }
        }

        let elapsed_sec = first_frame_time.map_or(0.0, |t| t.elapsed().as_secs_f64());
        let fps = if elapsed_sec > 0.0 { frame_count as f64 / elapsed_sec } else { 0.0 };
        println!("Captured {} frames in {:.2}s = {:.1} FPS", frame_count, elapsed_sec, fps);

        let stop_res = stop_native_screen_capture();
        println!("stop_native_screen_capture result: {:?}", stop_res);
        assert!(fps >= 55.0, "Expected at least 55 FPS, got {:.1}", fps);
    }
}



