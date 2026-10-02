use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use image::codecs::jpeg::JpegEncoder;
use crate::video_jpeg::RealtimeJpegEncoder;
#[cfg(test)]
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
static WS_TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
static FRAME_SENDER: std::sync::OnceLock<broadcast::Sender<Message>> = std::sync::OnceLock::new();
struct CaptureSession {
    source: String,
    active: Arc<AtomicBool>,
    sender: broadcast::Sender<Message>,
    metrics: Arc<CaptureMetrics>,
    load: Arc<crate::video_load::CaptureLoad>,
    #[cfg(windows)]
    control: Option<ActiveCaptureControl>,
}
static SESSIONS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, CaptureSession>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

#[derive(Default)]
pub struct CaptureMetrics {
    callbacks: std::sync::atomic::AtomicU64,
    gated: std::sync::atomic::AtomicU64,
    images: std::sync::atomic::AtomicU64,
    readback_us: std::sync::atomic::AtomicU64,
    jpeg_us: std::sync::atomic::AtomicU64,
    processing_us: std::sync::atomic::AtomicU64,
    staging_allocations: std::sync::atomic::AtomicU64,
    readback_errors: std::sync::atomic::AtomicU64,
    resize_us: std::sync::atomic::AtomicU64,
    gpu_scaled_images: std::sync::atomic::AtomicU64,
}

#[derive(Serialize)]
pub struct CaptureMetricsSnapshot {
    callbacks: u64, gated: u64, images: u64, readback_us: u64, jpeg_us: u64, processing_us: u64,
    staging_allocations: u64, readback_errors: u64, resize_us: u64,
    gpu_scaled_images: u64,
    load: crate::video_load::LoadSnapshot,
}

#[tauri::command]
pub fn get_capture_metrics(session_id: String) -> Result<CaptureMetricsSnapshot, String> {
    let sessions = SESSIONS.lock().map_err(|_| "Capture session lock poisoned")?;
    let session = sessions.get(&session_id).ok_or("Capture session is no longer active")?;
    let metrics = &session.metrics;
    Ok(CaptureMetricsSnapshot {
        callbacks: metrics.callbacks.load(Ordering::Relaxed), gated: metrics.gated.load(Ordering::Relaxed),
        images: metrics.images.load(Ordering::Relaxed), readback_us: metrics.readback_us.load(Ordering::Relaxed),
        jpeg_us: metrics.jpeg_us.load(Ordering::Relaxed), processing_us: metrics.processing_us.load(Ordering::Relaxed),
        staging_allocations: metrics.staging_allocations.load(Ordering::Relaxed),
        readback_errors: metrics.readback_errors.load(Ordering::Relaxed),
        resize_us: metrics.resize_us.load(Ordering::Relaxed),
        gpu_scaled_images: metrics.gpu_scaled_images.load(Ordering::Relaxed),
        load: session.load.snapshot(),
    })
}

#[tauri::command]
pub fn report_capture_load(session_id: String, feedback_token: String, pressure_percent: u32) -> Result<u32, String> {
    let sessions = SESSIONS.lock().map_err(|_| "Capture session lock poisoned")?;
    let load = &sessions.get(&session_id).ok_or("Capture session is no longer active")?.load;
    load.report_bridge(&feedback_token, pressure_percent)?;
    Ok(load.fps())
}

#[derive(Clone)]
pub struct CaptureFlags {
    pub load: Arc<crate::video_load::CaptureLoad>,
    pub sender: broadcast::Sender<Message>,
    pub target_fps: u32,
    pub target_width: u32,
    pub target_height: u32,
    pub quality: u8,
    pub active_flag: Arc<AtomicBool>,
    pub latest_frame: Arc<std::sync::Mutex<Option<Arc<Vec<u8>>>>>,
    pub last_sent_us: Arc<std::sync::atomic::AtomicU64>,
    pub start_instant: std::time::Instant,
    pub metrics: Arc<CaptureMetrics>,
}

#[cfg(windows)]
pub struct NativeWgcHandler {
    load: Arc<crate::video_load::CaptureLoad>,
    load_controller: crate::video_load::LoadController,
    sender: broadcast::Sender<Message>,
    target_width: u32,
    target_height: u32,
    active_flag: Arc<AtomicBool>,
    raw_buffer: Vec<u8>,
    readback: crate::video_readback::ReusableReadback,
    legacy_readback: bool,
    consecutive_readback_errors: u8,
    gpu_scaler: crate::video_gpu_scale::GpuScaler,
    gpu_scaling_disabled: bool,
    resized_image: Option<fast_image_resize::images::Image<'static>>,
    resizer: fast_image_resize::Resizer,
    jpeg_encoder: RealtimeJpegEncoder,
    next_frame_time: std::time::Instant,
    frame_interval: std::time::Duration,
    latest_frame: Arc<std::sync::Mutex<Option<Arc<Vec<u8>>>>>,
    last_sent_us: Arc<std::sync::atomic::AtomicU64>,
    start_instant: std::time::Instant,
    metrics: Arc<CaptureMetrics>,
}

#[cfg(windows)]
impl GraphicsCaptureApiHandler for NativeWgcHandler {
    type Flags = CaptureFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let fps = ctx.flags.target_fps.clamp(15, 120);
        let frame_interval = std::time::Duration::from_nanos(1_000_000_000 / fps as u64);
        Ok(Self {
            load: ctx.flags.load,
            load_controller: crate::video_load::LoadController::default(),
            sender: ctx.flags.sender,
            target_width: ctx.flags.target_width,
            target_height: ctx.flags.target_height,
            active_flag: ctx.flags.active_flag,
            raw_buffer: Vec::new(),
            readback: crate::video_readback::ReusableReadback::default(),
            legacy_readback: std::env::var("P2SHARER_LEGACY_VIDEO_READBACK").as_deref() == Ok("1"),
            consecutive_readback_errors: 0,
            gpu_scaler: crate::video_gpu_scale::GpuScaler::default(),
            gpu_scaling_disabled: false,
            resized_image: None,
            resizer: fast_image_resize::Resizer::new(),
            jpeg_encoder: RealtimeJpegEncoder::new(ctx.flags.quality)?,
            next_frame_time: std::time::Instant::now(),
            frame_interval,
            latest_frame: ctx.flags.latest_frame,
            last_sent_us: ctx.flags.last_sent_us,
            start_instant: ctx.flags.start_instant,
            metrics: ctx.flags.metrics,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if !self.active_flag.load(Ordering::Relaxed) {
            capture_control.stop();
            return Ok(());
        }

        // Keep the target cadence across callback jitter and non-matching refresh rates.
        // Resetting the gate after each frame can halve 60 FPS capture on a 75 Hz display.
        let arrival_time = std::time::Instant::now();
        self.frame_interval = std::time::Duration::from_nanos(1_000_000_000 / u64::from(self.load.fps()));
        self.metrics.callbacks.fetch_add(1, Ordering::Relaxed);
        if arrival_time < self.next_frame_time {
            self.metrics.gated.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }

        let mut src_width = frame.width();
        let mut src_height = frame.height();
        if src_width == 0 || src_height == 0 {
            return Ok(());
        }

        (self.target_width, self.target_height) = self.load.bounds(src_width, src_height);

        let scaled = if !self.legacy_readback && !self.gpu_scaling_disabled
            && self.target_width > 0 && self.target_height > 0
            && (src_width > self.target_width || src_height > self.target_height) {
            let (width, height) = fit_capture_dimensions(src_width, src_height, self.target_width, self.target_height);
            match self.gpu_scaler.resize(frame.device(), frame.device_context(), frame.as_raw_texture(), width, height) {
                Ok(texture) => { src_width = width; src_height = height; Some(texture) },
                Err(error) => {
                    self.gpu_scaling_disabled = true;
                    eprintln!("[Native Video] GPU downscaling unavailable; retaining CPU resize: {error}");
                    None
                }
            }
        } else { None };
        let mut frame_buffer = match if self.legacy_readback {
            frame.buffer().map(crate::video_readback::CapturePixels::Legacy).map_err(|error| -> Self::Error { error.into() })
        } else if let Some(texture) = scaled.as_ref() {
            self.readback.read_texture(frame.device(), frame.device_context(), texture)
                .map(crate::video_readback::CapturePixels::Reused).map_err(|error| -> Self::Error { error.into() })
        } else {
            self.readback.read(frame).map(crate::video_readback::CapturePixels::Reused).map_err(|error| -> Self::Error { error.into() })
        } {
            Ok(buf) => buf,
            Err(_e) => {
                self.metrics.readback_errors.fetch_add(1, Ordering::Relaxed);
                self.consecutive_readback_errors = self.consecutive_readback_errors.saturating_add(1);
                if !self.legacy_readback && self.consecutive_readback_errors >= 3 {
                    self.legacy_readback = true;
                    eprintln!("[Native Video] Reusable readback failed repeatedly; using legacy native readback: {_e}");
                }
                // Transient DXGI surface lock or swapchain mode switch (e.g. game launched / resized)
                // Returning Ok(()) ensures windows-capture does NOT abort the capture loop!
                return Ok(());
            }
        };
        self.next_frame_time += self.frame_interval;
        if arrival_time.saturating_duration_since(self.next_frame_time) >= self.frame_interval {
            self.next_frame_time = arrival_time + self.frame_interval;
        }
        let should_resize = self.target_width > 0
            && self.target_height > 0
            && (src_width > self.target_width || src_height > self.target_height);
        let row_bytes = src_width as usize * 4;
        let pixel_data = frame_buffer.packed(&mut self.raw_buffer, src_width, src_height);
        let pixel_pitch = row_bytes;
        self.metrics.readback_us.fetch_add(arrival_time.elapsed().as_micros() as u64, Ordering::Relaxed);
        let resize_start = std::time::Instant::now();
        let (final_pixels, final_w, final_h, final_pitch) = if should_resize {
            use fast_image_resize::images::{Image, ImageRef};
            use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions};

            if let Ok(src_img) = ImageRef::new(src_width, src_height, pixel_data, PixelType::U8x4) {
                let (dst_w, dst_h) = fit_capture_dimensions(src_width, src_height, self.target_width, self.target_height);

                if self
                    .resized_image
                    .as_ref()
                    .map_or(true, |img| img.width() != dst_w || img.height() != dst_h)
                {
                    self.resized_image = Some(Image::new(dst_w, dst_h, PixelType::U8x4));
                }

                if let Some(dst_img) = self.resized_image.as_mut() {
                    let options =
                        ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Box));
                    if self.resizer.resize(&src_img, dst_img, &options).is_ok() {
                        (dst_img.buffer(), dst_w, dst_h, dst_w as usize * 4)
                    } else {
                        (pixel_data, src_width, src_height, pixel_pitch)
                    }
                } else {
                    (pixel_data, src_width, src_height, pixel_pitch)
                }
            } else {
                (pixel_data, src_width, src_height, pixel_pitch)
            }
        } else {
            (pixel_data, src_width, src_height, pixel_pitch)
        };
        self.consecutive_readback_errors = 0;
        self.metrics.resize_us.fetch_add(resize_start.elapsed().as_micros() as u64, Ordering::Relaxed);

        let encode_start = std::time::Instant::now();
        if let Ok(frame_bytes) = self.jpeg_encoder.encode_rgba_strided(final_pixels, final_w, final_h, final_pitch) {
            self.load.output(final_w, final_h);
            if scaled.is_some() { self.metrics.gpu_scaled_images.fetch_add(1, Ordering::Relaxed); }
            self.metrics.images.fetch_add(1, Ordering::Relaxed);
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

        self.metrics.jpeg_us.fetch_add(encode_start.elapsed().as_micros() as u64, Ordering::Relaxed);
        drop(frame_buffer);
        if self.legacy_readback {
            self.metrics.staging_allocations.fetch_add(1, Ordering::Relaxed);
        } else {
            self.metrics.staging_allocations.store(self.readback.allocations(), Ordering::Relaxed);
        }
        let processing_us = arrival_time.elapsed().as_micros() as u64;
        self.metrics.processing_us.fetch_add(processing_us, Ordering::Relaxed);
        self.load_controller.observe(&self.load, self.load.elapsed_ms(), processing_us);

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
fn capture_update_interval() -> MinimumUpdateIntervalSettings {
    // A default Windows interval can quantize 60 FPS to 37.5 on a 75 Hz display.
    // Let WGC deliver changes promptly; the phase-preserving handler enforces user FPS.
    if windows_capture::graphics_capture_api::GraphicsCaptureApi::is_minimum_update_interval_supported().unwrap_or(false) {
        MinimumUpdateIntervalSettings::Custom(std::time::Duration::from_millis(4))
    } else {
        MinimumUpdateIntervalSettings::Default
    }
}



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

fn video_ws_token() -> &'static str {
    WS_TOKEN.get_or_init(|| {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).expect("secure randomness is required for video capture");
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    })
}

#[tauri::command]
pub fn get_video_ws_token() -> String {
    video_ws_token().to_owned()
}

pub fn is_video_capturing() -> bool {
    CAPTURING_VIDEO.load(Ordering::Relaxed)
}

pub fn is_wgc_active() -> bool {
    #[cfg(windows)]
    {
        if let Ok(guard) = SESSIONS.lock() {
            return guard.values().any(|session| session.control.is_some());
        }
    }
    false
}

// Start WebSocket server dynamically in a dedicated multi-threaded runtime
pub fn ensure_ws_server_running() {
    if WS_SERVER_INITIALIZED.swap(true, Ordering::SeqCst) {
        return;
    }

    let token = video_ws_token().to_owned();

    std::thread::spawn(move || {
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
                // Deliver frame tails immediately instead of waiting for TCP coalescing.
                let _ = stream.set_nodelay(true);
                let token = token.clone();

                tokio::spawn(async move {
                    if let Ok(Ok(ws_stream)) = tokio::time::timeout(
                        std::time::Duration::from_secs(3),
                        tokio_tungstenite::accept_async(stream),
                    ).await {
                        let (mut write, mut read) = ws_stream.split();
                        let candidate = match tokio::time::timeout(std::time::Duration::from_secs(3), read.next()).await {
                            Ok(Some(Ok(Message::Text(candidate)))) => candidate,
                            _ => String::new(),
                        };
                        let (credential, session_id) = candidate.split_once(':').unwrap_or((&candidate, "default"));
                        let authorized = credential == token;
                        let sender = if session_id == "default" { Some(get_frame_sender().clone()) } else {
                            SESSIONS.lock().ok().and_then(|sessions| sessions.get(session_id).map(|session| session.sender.clone()))
                        };
                        if !authorized || sender.is_none() {
                            let _ = write.send(Message::Close(None)).await;
                            return;
                        }
                        if write.send(Message::Text("auth-ok".into())).await.is_err() {
                            return;
                        }
                        let mut rx = sender.unwrap().subscribe();
                        loop {
                            tokio::select! {
                                msg = rx.recv() => {
                                    match msg {
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
                                client_msg = read.next() => {
                                    match client_msg {
                                        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None | Some(Err(_)) => {
                                            break;
                                        }
                                        _ => {}
                                    }
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
                let thumb = image::DynamicImage::ImageRgba8(rgba_img).thumbnail(320, 180);
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
                    let thumb = image::DynamicImage::ImageRgba8(rgba_img).thumbnail(320, 180);
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
    start_capture_session("default".into(), source_id, target_fps, target_width, target_height, capture_mouse, quality, None)
}

#[tauri::command]
pub fn start_capture_session(
    session_id: String, source_id: String, target_fps: Option<u32>, target_width: Option<u32>,
    target_height: Option<u32>, capture_mouse: Option<bool>, quality: Option<u8>,
    feedback_token: Option<String>,
) -> Result<bool, String> {
    if session_id.is_empty() || session_id.len() > 100 { return Err("Invalid capture session".into()); }
    if source_id.trim().is_empty() {
        return Err("sourceId cannot be empty".to_string());
    }
    ensure_ws_server_running();

    // Stop any existing capture session first
    let _ = stop_capture_session(session_id.clone());

    if session_id == "default" { crate::stream_pointer::set_source(Some(source_id.clone())); }
    CAPTURING_VIDEO.store(true, Ordering::SeqCst);
    let is_capturing = Arc::new(AtomicBool::new(true));
    let is_capturing_clone = is_capturing.clone();



    let fps = target_fps.unwrap_or(60).clamp(15, 120);
    let width = target_width.unwrap_or(0);
    let height = target_height.unwrap_or(0);
    let should_draw_mouse = capture_mouse.unwrap_or(true);
    let jpeg_quality = quality.unwrap_or(90).clamp(50, 98);

    let sender = if session_id == "default" { get_frame_sender().clone() } else { broadcast::channel(32).0 };
    let metrics = Arc::new(CaptureMetrics::default());
    let load = Arc::new(crate::video_load::CaptureLoad::new(fps, width, height, feedback_token));
    SESSIONS.lock().map_err(|_| "Capture session lock poisoned")?.insert(session_id.clone(), CaptureSession {
        source: source_id.clone(),
        active: is_capturing.clone(), sender: sender.clone(),
        metrics: metrics.clone(),
        load: load.clone(),
        #[cfg(windows)]
        control: None,
    });
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
    let pacer_load = load.clone();

    std::thread::spawn(move || {
        let _timer_guard = MultimediaTimerGuard::new();
        let mut next_tick_us = pacer_start.elapsed().as_micros() as u64 + 1_000_000 / u64::from(pacer_load.fps());
        let mut pacer_tick_count: u64 = 0;

        while pacer_active.load(Ordering::Relaxed) {
            let target_interval_us = 1_000_000 / u64::from(pacer_load.fps());
            let static_timeout_us = target_interval_us * 4;
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
            metrics: metrics.clone(),
            load: load.clone(),
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
                    capture_update_interval(),
                    DirtyRegionSettings::Default,
                    ColorFormat::Rgba8,
                    flags.clone(),
                );

                match NativeWgcHandler::start_free_threaded(settings) {
                    Ok(control) => {
                        if let Ok(mut guard) = SESSIONS.lock() {
                            if let Some(session) = guard.get_mut(&session_id) { session.control = Some(control); }
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
                    capture_update_interval(),
                    DirtyRegionSettings::Default,
                    ColorFormat::Rgba8,
                    flags.clone(),
                );

                match NativeWgcHandler::start_free_threaded(settings) {
                    Ok(control) => {
                        if let Ok(mut guard) = SESSIONS.lock() {
                            if let Some(session) = guard.get_mut(&session_id) { session.control = Some(control); }
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
    let xcap_latest_cache = latest_frame_cache.clone();
    let xcap_last_sent_us = last_sent_us.clone();
    std::thread::spawn(move || {
        let _timer_guard = MultimediaTimerGuard::new();
        let mut load_controller = crate::video_load::LoadController::default();

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
        let mut jpeg_encoder = match RealtimeJpegEncoder::new(jpeg_quality) {
            Ok(encoder) => encoder,
            Err(error) => {
                eprintln!("[Native Video] JPEG encoder initialization failed: {error}");
                let _ = sender.send(Message::Text("{\"type\":\"fallback\",\"reason\":\"capture_error\"}".into()));
                is_capturing_clone.store(false, Ordering::Relaxed);
                return;
            }
        };
        let mut resizer = fast_image_resize::Resizer::new();
        let mut resized_img_buf: Option<fast_image_resize::images::Image<'static>> = None;

        while is_capturing_clone.load(Ordering::Relaxed)
        {
            let loop_start = std::time::Instant::now();
            let frame_interval = std::time::Duration::from_nanos(1_000_000_000 / u64::from(load.fps()));

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
                let (width, height) = load.bounds(src_w, src_h);

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

                if let Ok(jpeg_bytes) = jpeg_encoder.encode_rgba(final_raw, final_w, final_h) {
                    load.output(final_w, final_h);
                    metrics.images.fetch_add(1, Ordering::Relaxed);
                    let frame_arc = Arc::new(jpeg_bytes);
                    if let Ok(mut cache) = xcap_latest_cache.lock() {
                        *cache = Some(frame_arc.clone());
                    }
                    xcap_last_sent_us.store(
                        start_instant.elapsed().as_micros() as u64,
                        Ordering::Release,
                    );
                    let _ = sender.send(Message::Binary((*frame_arc).clone()));
                    let processing_us = loop_start.elapsed().as_micros() as u64;
                    metrics.processing_us.fetch_add(processing_us, Ordering::Relaxed);
                    load_controller.observe(&load, load.elapsed_ms(), processing_us);
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

#[cfg(windows)]
fn safely_stop_wgc_control(control: ActiveCaptureControl) {
    use std::os::windows::prelude::AsRawHandle;
    use windows::Win32::Foundation::{HANDLE, LPARAM, WPARAM};
    use windows::Win32::System::Threading::GetThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};

    // 1. Signal halt flag immediately so on_frame_arrived halts without spinning
    control.halt_handle().store(true, Ordering::SeqCst);

    // 2. Extract thread handle and its raw Win32 thread ID
    let thread_handle = control.into_thread_handle();
    let raw_handle = thread_handle.as_raw_handle();
    let thread_id = unsafe { GetThreadId(HANDLE(raw_handle)) };

    // 3. Spawn a graceful shutdown task that NEVER busy-loops with yield_now()
    std::thread::spawn(move || {
        if thread_id != 0 {
            // Post WM_QUIT to break Message Loop 1
            let _ = unsafe { PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };

            // Wait briefly to allow ShutdownQueueAsync to initiate cleanly
            std::thread::sleep(std::time::Duration::from_millis(30));

            // Post WM_QUIT again to ensure Message Loop 2 unblocks even if WinRT
            // dispatched AsyncActionCompletedHandler onto a different COM thread
            if !thread_handle.is_finished() {
                let _ = unsafe { PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
            }
        }

        // 4. Polite bounded poll (max 600ms total, 20ms sleeps = 0% CPU)
        let start = std::time::Instant::now();
        while !thread_handle.is_finished() && start.elapsed().as_millis() < 600 {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        if thread_handle.is_finished() {
            let _ = thread_handle.join();
        }
    });
}

#[tauri::command]
pub fn stop_native_screen_capture() -> Result<bool, String> {
    let ids: Vec<String> = SESSIONS.lock().map_err(|_| "Capture session lock poisoned")?.keys().cloned().collect();
    for id in ids { stop_capture_session(id)?; }
    Ok(true)
}

#[tauri::command]
pub fn stop_capture_session(session_id: String) -> Result<bool, String> {
    let session = SESSIONS.lock().map_err(|_| "Capture session lock poisoned")?.remove(&session_id);
    if let Some(session) = session {
        session.active.store(false, Ordering::SeqCst);
        #[cfg(windows)]
        if let Some(control) = session.control { safely_stop_wgc_control(control); }
    }
    let empty = SESSIONS.lock().map_err(|_| "Capture session lock poisoned")?.is_empty();
    CAPTURING_VIDEO.store(!empty, Ordering::SeqCst);
    if empty { crate::stream_pointer::set_source(None); }
    Ok(true)
}

#[tauri::command]
pub fn select_pointer_capture(session_id: Option<String>) -> Result<(), String> {
    let source = match session_id {
        Some(id) => Some(SESSIONS.lock().map_err(|_| "Capture session lock poisoned")?
            .get(&id).ok_or("Capture session is no longer active")?.source.clone()),
        None => None,
    };
    crate::stream_pointer::set_source(source);
    Ok(())
}

pub fn pointer_capture_source(session_id: &str) -> Option<String> {
    SESSIONS.lock().ok()?.get(session_id).map(|session| session.source.clone())
}

/// Bound capture dimensions without changing the monitor/window aspect ratio or upscaling.
pub(crate) fn fit_capture_dimensions(width: u32, height: u32, max_width: u32, max_height: u32) -> (u32, u32) {
    if width == 0 || height == 0 || max_width == 0 || max_height == 0 { return (width, height); }
    let scale = (max_width as f64 / width as f64).min(max_height as f64 / height as f64).min(1.0);
    ((width as f64 * scale).round().max(1.0) as u32, (height as f64 * scale).round().max(1.0) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_dimensions_preserve_portrait_and_window_aspect_ratios() {
        assert_eq!(fit_capture_dimensions(1080, 1920, 1920, 1080), (608, 1080));
        assert_eq!(fit_capture_dimensions(2560, 1440, 1920, 1080), (1920, 1080));
        assert_eq!(fit_capture_dimensions(1000, 1000, 1920, 1080), (1000, 1000));
        assert_eq!(fit_capture_dimensions(800, 600, 640, 360), (480, 360));
    }

    #[tokio::test]
    async fn video_websocket_routes_only_the_authenticated_capture_session() {
        ensure_ws_server_running();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while get_video_ws_port() == 0 && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let (a, _) = broadcast::channel(32);
        let (b, _) = broadcast::channel(32);
        for (id, sender) in [("socket-test-a", a.clone()), ("socket-test-b", b.clone())] {
            SESSIONS.lock().unwrap().insert(id.into(), CaptureSession {
                metrics: Arc::new(CaptureMetrics::default()),
                load: Arc::new(crate::video_load::CaptureLoad::new(60, 0, 0, None)),
                source: "screen:0".into(), active: Arc::new(AtomicBool::new(true)), sender,
                #[cfg(windows)]
                control: None,
            });
        }
        let url = format!("ws://127.0.0.1:{}", get_video_ws_port());
        let (mut first, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        let (mut second, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        first.send(Message::Text(format!("{}:socket-test-a", video_ws_token()))).await.unwrap();
        second.send(Message::Text(format!("{}:socket-test-b", video_ws_token()))).await.unwrap();
        assert_eq!(first.next().await.unwrap().unwrap().into_text().unwrap(), "auth-ok");
        assert_eq!(second.next().await.unwrap().unwrap().into_text().unwrap(), "auth-ok");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        a.send(Message::Binary(vec![11, 11, 11, 11, 11])).unwrap();
        b.send(Message::Binary(vec![22, 22, 22, 22, 22])).unwrap();
        assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(2), first.next()).await.unwrap().unwrap().unwrap().into_data(), vec![11; 5]);
        assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(2), second.next()).await.unwrap().unwrap().unwrap().into_data(), vec![22; 5]);
        stop_capture_session("socket-test-a".into()).unwrap();
        b.send(Message::Binary(vec![33; 5])).unwrap();
        assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(2), second.next()).await.unwrap().unwrap().unwrap().into_data(), vec![33; 5]);
        stop_capture_session("socket-test-b".into()).unwrap();
    }

    #[test]
    fn simultaneous_native_sessions_keep_frames_and_teardown_independent() {
        start_capture_session("capture-test-a".into(), "screen:0".into(), Some(30), Some(640), Some(360), Some(true), Some(75), None).unwrap();
        start_capture_session("capture-test-b".into(), "screen:0".into(), Some(30), Some(320), Some(180), Some(true), Some(85), None).unwrap();
        let (mut first, mut second, second_active) = {
            let sessions = SESSIONS.lock().unwrap();
            let a = sessions.get("capture-test-a").unwrap();
            let b = sessions.get("capture-test-b").unwrap();
            (a.sender.subscribe(), b.sender.subscribe(), b.active.clone())
        };
        fn next_image(rx: &mut broadcast::Receiver<Message>) -> (u32, u32) {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while std::time::Instant::now() < deadline {
                match rx.try_recv() {
                    Ok(Message::Binary(bytes)) if bytes.len() > 4 => {
                        let image = image::load_from_memory(&bytes).unwrap();
                        return (image.width(), image.height());
                    }
                    _ => std::thread::sleep(std::time::Duration::from_millis(5)),
                }
            }
            panic!("Capture did not produce an image frame");
        }
        assert_eq!(next_image(&mut first), (640, 360));
        assert_eq!(next_image(&mut second), (320, 180));
        stop_capture_session("capture-test-a".into()).unwrap();
        assert!(second_active.load(Ordering::SeqCst));
        assert!(is_video_capturing());
        assert_eq!(next_image(&mut second), (320, 180));
        stop_capture_session("capture-test-b".into()).unwrap();
        assert!(!second_active.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn video_websocket_requires_process_token_before_streaming() {
        ensure_ws_server_running();
        let port = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let port = get_video_ws_port();
                if port != 0 { break port; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.expect("video WebSocket did not start");
        let url = format!("ws://127.0.0.1:{port}");

        let (mut unauthorized, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        unauthorized.send(Message::Text("invalid".into())).await.unwrap();
        let rejected = tokio::time::timeout(std::time::Duration::from_secs(2), unauthorized.next())
            .await.expect("unauthorized client was not disconnected");
        assert!(matches!(rejected, Some(Ok(Message::Close(_)))));

        let (mut authorized, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        authorized.send(Message::Text(video_ws_token().into())).await.unwrap();
        let acknowledgement = tokio::time::timeout(std::time::Duration::from_secs(2), authorized.next())
            .await.unwrap().unwrap().unwrap();
        assert_eq!(acknowledgement.into_text().unwrap(), "auth-ok");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        get_frame_sender().send(Message::Binary(vec![1, 2, 3])).unwrap();
        // A capture stopped by an earlier test can finish one in-flight callback.
        // Authentication must deliver the marker, not depend on its being first.
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while let Some(message) = authorized.next().await {
                if message.unwrap() == Message::Binary(vec![1, 2, 3]) { return; }
            }
            panic!("Authenticated video socket closed before receiving the marker");
        }).await.expect("Authenticated video socket did not deliver the marker");
    }

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
        let mut image_frame_count = 0;
        let mut heartbeat_count = 0;
        let measure_duration = std::time::Duration::from_millis(2000);

        while timeout.elapsed().as_millis() < 4000 {
            match rx.try_recv() {
                Ok(tokio_tungstenite::tungstenite::Message::Binary(bytes)) => {
                    if first_frame_time.is_none() {
                        first_frame_time = Some(std::time::Instant::now());
                        println!("First frame received! size = {} bytes", bytes.len());
                    }
                    if bytes.len() > 4 {
                        image_frame_count += 1;
                    } else {
                        heartbeat_count += 1;
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
        println!("Captured {} messages in {:.2}s = {:.1} messages/s ({} images, {} heartbeats)", frame_count, elapsed_sec, fps, image_frame_count, heartbeat_count);

        let stop_res = stop_native_screen_capture();
        println!("stop_native_screen_capture result: {:?}", stop_res);
        assert!(fps >= 55.0, "Expected at least 55 FPS, got {:.1}", fps);
        assert!(image_frame_count > 0, "Capture produced only heartbeat messages");
    }
}



