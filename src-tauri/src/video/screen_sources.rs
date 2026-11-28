use crate::video_jpeg::RealtimeJpegEncoder;
use crate::video_pacer::{FramePacer, PacedFrame};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use image::codecs::jpeg::JpegEncoder;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::protocol::Message;
use xcap::{Monitor, Window};

type FrameDelivery = Arc<(
    std::sync::Mutex<FramePacer<Arc<Vec<u8>>>>,
    std::sync::Condvar,
)>;

#[cfg(windows)]
use windows_capture::{
    monitor::Monitor as WgcMonitor,
    settings::{
        CursorCaptureSettings, DrawBorderSettings, GraphicsCaptureItemType,
        MinimumUpdateIntervalSettings,
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
    nvenc_enabled: Arc<AtomicBool>,
    nvenc_keyframe: Arc<AtomicBool>,
    wgc_thread_id: Arc<std::sync::atomic::AtomicU32>,
    nvenc_bitrate: Arc<std::sync::atomic::AtomicU32>,
    consumers_active: Arc<AtomicBool>,
    native_route_count: Arc<AtomicUsize>,
    source: String,
    active: Arc<AtomicBool>,
    sender: broadcast::Sender<Message>,
    terminal_signal: Option<Message>,
    metrics: Arc<CaptureMetrics>,
    load: Arc<crate::video_load::CaptureLoad>,
    #[cfg(windows)]
    control: Option<ActiveCaptureControl>,
}
static SESSIONS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, CaptureSession>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn signal_capture_end(session_id: &str, active: &Arc<AtomicBool>, reason: &str) {
    if let Ok(mut sessions) = SESSIONS.lock() {
        if let Some(session) = sessions.get_mut(session_id) {
            if Arc::ptr_eq(&session.active, active) && active.load(Ordering::Acquire) {
                let message =
                    Message::Text(format!("{{\"type\":\"fallback\",\"reason\":\"{reason}\"}}"));
                session.terminal_signal = Some(message.clone());
                let _ = session.sender.send(message);
            }
        }
    }
}

pub struct NativeRouteGuard(Arc<AtomicUsize>);
impl Drop for NativeRouteGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct EncodedCapture {
    pub frames: broadcast::Receiver<Message>,
    pub active: Arc<AtomicBool>,
    pub keyframe: Arc<AtomicBool>,
    pub wgc_thread_id: Arc<std::sync::atomic::AtomicU32>,
    pub bitrate: Arc<std::sync::atomic::AtomicU32>,
    pub load: Arc<crate::video_load::CaptureLoad>,
    pub route_guard: Arc<NativeRouteGuard>,
}
impl EncodedCapture {
    pub fn request_keyframe(&self) {
        request_capture_keyframe(&self.keyframe, &self.wgc_thread_id);
    }
}
pub fn request_capture_keyframe(
    keyframe: &AtomicBool,
    wgc_thread_id: &std::sync::atomic::AtomicU32,
) {
    keyframe.store(true, Ordering::Release);
    #[cfg(windows)]
    {
        let thread_id = wgc_thread_id.load(Ordering::Acquire);
        if thread_id != 0 {
            unsafe {
                let _ = windows_capture_api::Win32::UI::WindowsAndMessaging::PostThreadMessageW(
                    thread_id,
                    WM_APP_REQUEST_KEYFRAME,
                    windows_capture_api::Win32::Foundation::WPARAM(0),
                    windows_capture_api::Win32::Foundation::LPARAM(0),
                );
            }
        }
    }
}
pub fn encoded_capture(id: &str, token: &str) -> Result<EncodedCapture, String> {
    let sessions = SESSIONS
        .lock()
        .map_err(|_| "Capture session lock poisoned")?;
    let session = sessions
        .get(id)
        .ok_or("Capture session is no longer active")?;
    session.load.validate_token(token)?;
    if !session.nvenc_enabled.load(Ordering::Relaxed) {
        return Err("Native encoder is unavailable".into());
    }
    session.native_route_count.fetch_add(1, Ordering::AcqRel);
    let route_guard = Arc::new(NativeRouteGuard(session.native_route_count.clone()));
    Ok(EncodedCapture {
        frames: session.sender.subscribe(),
        active: session.active.clone(),
        keyframe: session.nvenc_keyframe.clone(),
        wgc_thread_id: session.wgc_thread_id.clone(),
        bitrate: session.nvenc_bitrate.clone(),
        load: session.load.clone(),
        route_guard,
    })
}

#[derive(Default)]
pub struct CaptureMetrics {
    capture_backend: std::sync::atomic::AtomicU8,
    encoder_kind: std::sync::atomic::AtomicU8,
    cursor_requested: AtomicBool,
    cursor_embedded: AtomicBool,
    jpeg_errors: std::sync::atomic::AtomicU64,
    #[cfg(feature = "media-diagnostics")]
    last_callback_us: std::sync::atomic::AtomicU64,
    #[cfg(feature = "media-diagnostics")]
    last_delivery_us: std::sync::atomic::AtomicU64,
    #[cfg(feature = "media-diagnostics")]
    max_callback_gap_us: std::sync::atomic::AtomicU64,
    #[cfg(feature = "media-diagnostics")]
    max_delivery_gap_us: std::sync::atomic::AtomicU64,
    nvenc_images: std::sync::atomic::AtomicU64,
    nvenc_us: std::sync::atomic::AtomicU64,
    nvenc_fallbacks: std::sync::atomic::AtomicU64,
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
    paced_images: std::sync::atomic::AtomicU64,
    repeat_ticks: std::sync::atomic::AtomicU64,
    refresh_images: std::sync::atomic::AtomicU64,
    queue_drops: std::sync::atomic::AtomicU64,
    missed_deadlines: std::sync::atomic::AtomicU64,
    queue_age_us: std::sync::atomic::AtomicU64,
    max_queue_age_us: std::sync::atomic::AtomicU64,
}

fn log_selected_encoder(
    metrics: &CaptureMetrics,
    session: &str,
    encoder: u8,
    width: u32,
    height: u32,
    fps: u32,
    elapsed_ms: u128,
) {
    if metrics.encoder_kind.swap(encoder, Ordering::Relaxed) != encoder {
        crate::logger::log_msg("INFO", "capture.encoder", &format!(
            "session={session} encoder={} output={width}x{height} fps={fps} elapsed_ms={elapsed_ms} first_successful_frame=true",
            match encoder { 1 => "NVENC/H264", 3 => "MediaFoundation/H264", _ => "libjpeg-turbo/JPEG" }));
    }
}

#[derive(Serialize)]
pub struct CaptureMetricsSnapshot {
    capture_backend: u8,
    nvenc_images: u64,
    nvenc_us: u64,
    nvenc_fallbacks: u64,
    callbacks: u64,
    gated: u64,
    images: u64,
    readback_us: u64,
    jpeg_us: u64,
    processing_us: u64,
    staging_allocations: u64,
    readback_errors: u64,
    resize_us: u64,
    gpu_scaled_images: u64,
    load: crate::video_load::LoadSnapshot,
    paced_images: u64,
    repeat_ticks: u64,
    refresh_images: u64,
    queue_drops: u64,
    missed_deadlines: u64,
    queue_age_us: u64,
    max_queue_age_us: u64,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ActiveCaptureDiagnosticSnapshot {
    pub session_index: usize,
    pub backend: &'static str,
    pub encoder: &'static str,
    pub callbacks: u64,
    pub gated: u64,
    pub images: u64,
    pub nvenc_images: u64,
    pub nvenc_us: u64,
    pub nvenc_fallbacks: u64,
    pub readback_us: u64,
    pub jpeg_us: u64,
    pub resize_us: u64,
    pub processing_us: u64,
    pub gpu_scaled_images: u64,
    pub staging_allocations: u64,
    pub readback_errors: u64,
    pub jpeg_errors: u64,
    pub paced_images: u64,
    pub repeat_ticks: u64,
    pub refresh_images: u64,
    pub queue_drops: u64,
    pub missed_deadlines: u64,
    pub max_queue_age_us: u64,
}

pub(crate) fn active_capture_diagnostics() -> Vec<ActiveCaptureDiagnosticSnapshot> {
    let Ok(sessions) = SESSIONS.try_lock() else {
        return Vec::new();
    };
    sessions
        .values()
        .enumerate()
        .map(|(session_index, session)| {
            let m = &session.metrics;
            let backend = match m.capture_backend.load(Ordering::Relaxed) {
                1 => "WGC",
                2 => "DXGI",
                3 => "xcap",
                _ => "unknown",
            };
            let encoder = match m.encoder_kind.load(Ordering::Relaxed) {
                1 => "NVENC/H264",
                2 => "libjpeg-turbo/JPEG",
                3 => "MediaFoundation/H264",
                _ => "pending",
            };
            ActiveCaptureDiagnosticSnapshot {
                session_index,
                backend,
                encoder,
                callbacks: m.callbacks.load(Ordering::Relaxed),
                gated: m.gated.load(Ordering::Relaxed),
                images: m.images.load(Ordering::Relaxed),
                nvenc_images: m.nvenc_images.load(Ordering::Relaxed),
                nvenc_us: m.nvenc_us.load(Ordering::Relaxed),
                nvenc_fallbacks: m.nvenc_fallbacks.load(Ordering::Relaxed),
                readback_us: m.readback_us.load(Ordering::Relaxed),
                jpeg_us: m.jpeg_us.load(Ordering::Relaxed),
                resize_us: m.resize_us.load(Ordering::Relaxed),
                processing_us: m.processing_us.load(Ordering::Relaxed),
                gpu_scaled_images: m.gpu_scaled_images.load(Ordering::Relaxed),
                staging_allocations: m.staging_allocations.load(Ordering::Relaxed),
                readback_errors: m.readback_errors.load(Ordering::Relaxed),
                jpeg_errors: m.jpeg_errors.load(Ordering::Relaxed),
                paced_images: m.paced_images.load(Ordering::Relaxed),
                repeat_ticks: m.repeat_ticks.load(Ordering::Relaxed),
                refresh_images: m.refresh_images.load(Ordering::Relaxed),
                queue_drops: m.queue_drops.load(Ordering::Relaxed),
                missed_deadlines: m.missed_deadlines.load(Ordering::Relaxed),
                max_queue_age_us: m.max_queue_age_us.load(Ordering::Relaxed),
            }
        })
        .collect()
}

#[tauri::command]
pub fn get_capture_metrics(session_id: String) -> Result<CaptureMetricsSnapshot, String> {
    let sessions = SESSIONS
        .lock()
        .map_err(|_| "Capture session lock poisoned")?;
    let session = sessions
        .get(&session_id)
        .ok_or("Capture session is no longer active")?;
    Ok(metrics_snapshot(session))
}

fn metrics_snapshot(session: &CaptureSession) -> CaptureMetricsSnapshot {
    let metrics = &session.metrics;
    CaptureMetricsSnapshot {
        capture_backend: metrics.capture_backend.load(Ordering::Relaxed),
        nvenc_images: metrics.nvenc_images.load(Ordering::Relaxed),
        nvenc_us: metrics.nvenc_us.load(Ordering::Relaxed),
        nvenc_fallbacks: metrics.nvenc_fallbacks.load(Ordering::Relaxed),
        callbacks: metrics.callbacks.load(Ordering::Relaxed),
        gated: metrics.gated.load(Ordering::Relaxed),
        images: metrics.images.load(Ordering::Relaxed),
        readback_us: metrics.readback_us.load(Ordering::Relaxed),
        jpeg_us: metrics.jpeg_us.load(Ordering::Relaxed),
        processing_us: metrics.processing_us.load(Ordering::Relaxed),
        staging_allocations: metrics.staging_allocations.load(Ordering::Relaxed),
        readback_errors: metrics.readback_errors.load(Ordering::Relaxed),
        resize_us: metrics.resize_us.load(Ordering::Relaxed),
        gpu_scaled_images: metrics.gpu_scaled_images.load(Ordering::Relaxed),
        load: session.load.snapshot(),
        paced_images: metrics.paced_images.load(Ordering::Relaxed),
        repeat_ticks: metrics.repeat_ticks.load(Ordering::Relaxed),
        refresh_images: metrics.refresh_images.load(Ordering::Relaxed),
        queue_drops: metrics.queue_drops.load(Ordering::Relaxed),
        missed_deadlines: metrics.missed_deadlines.load(Ordering::Relaxed),
        queue_age_us: metrics.queue_age_us.load(Ordering::Relaxed),
        max_queue_age_us: metrics.max_queue_age_us.load(Ordering::Relaxed),
    }
}

#[cfg(feature = "media-diagnostics")]
pub(crate) fn diagnostic_snapshot() -> serde_json::Value {
    match SESSIONS.try_lock() {
        Ok(sessions) => {
            serde_json::json!({ "captures": sessions.iter().take(32).map(|(id, session)| {
            serde_json::json!({"session": crate::media_diagnostics::opaque_id(id),
                "active": session.active.load(Ordering::Relaxed),
                "nvenc": session.nvenc_enabled.load(Ordering::Relaxed),
                "encoder_bitrate": session.nvenc_bitrate.load(Ordering::Relaxed),
                "metrics": metrics_snapshot(session),
                "callback_age_us": diagnostic_age(session.metrics.last_callback_us.load(Ordering::Relaxed)),
                "delivery_age_us": diagnostic_age(session.metrics.last_delivery_us.load(Ordering::Relaxed)),
                "max_callback_gap_us": session.metrics.max_callback_gap_us.load(Ordering::Relaxed),
                "max_delivery_gap_us": session.metrics.max_delivery_gap_us.load(Ordering::Relaxed)})
        }).collect::<Vec<_>>() })
        }
        Err(_) => serde_json::json!({"capture_lock_busy": true}),
    }
}

#[tauri::command]
pub fn report_capture_load(
    session_id: String,
    feedback_token: String,
    pressure_percent: u32,
) -> Result<u32, String> {
    let sessions = SESSIONS
        .lock()
        .map_err(|_| "Capture session lock poisoned")?;
    let load = &sessions
        .get(&session_id)
        .ok_or("Capture session is no longer active")?
        .load;
    load.report_bridge(&feedback_token, pressure_percent)?;
    Ok(load.fps())
}

#[tauri::command]
pub fn update_capture_profile(
    window: tauri::Window,
    session_id: String,
    feedback_token: String,
    target_fps: u32,
    target_width: u32,
    target_height: u32,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can update capture profiles".into());
    }
    let sessions = SESSIONS
        .lock()
        .map_err(|_| "Capture session lock poisoned")?;
    let load = &sessions
        .get(&session_id)
        .ok_or("Capture session is no longer active")?
        .load;
    load.set_profile(&feedback_token, target_fps, target_width, target_height)
}

#[tauri::command]
pub async fn get_native_encoder_support() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let started = std::time::Instant::now();
        #[cfg(windows)]
        let support = crate::video_nvenc::probe_session();
        #[cfg(not(windows))]
        let support: Result<(), String> = Err("Native NVENC requires Windows".into());
        crate::logger::log_msg(if support.is_ok() { "INFO" } else { "WARN" }, "capture.nvenc.probe", &format!(
            "available={} elapsed_ms={} reason={:?}", support.is_ok(), started.elapsed().as_millis(), support.as_ref().err()));
        serde_json::json!({ "driver_api_available": support.is_ok(),
            "experimental_enabled": nvenc_requested(Some("auto"), std::env::var("P2SHARER_NATIVE_NVENC").ok().as_deref()),
            "reason": support.err(), "transport": "native_h264_rtp" })
    }).await.map_err(|error| error.to_string())
}

// Generic skips the vendor SDK, but can use the Windows hardware encoder.
fn nvenc_requested(preference: Option<&str>, diagnostic: Option<&str>) -> bool {
    match preference {
        Some("generic") => false,
        Some("nvenc") => true,
        _ => diagnostic != Some("0"),
    }
}

fn mf_requested(diagnostic: Option<&str>) -> bool {
    diagnostic != Some("0")
}

#[tauri::command]
pub fn control_capture_encoder(
    session_id: String,
    feedback_token: String,
    disable: bool,
    consumers_active: Option<bool>,
) -> Result<(), String> {
    let sessions = SESSIONS
        .lock()
        .map_err(|_| "Capture session lock poisoned")?;
    let session = sessions
        .get(&session_id)
        .ok_or("Capture session is no longer active")?;
    session.load.validate_token(&feedback_token)?;
    if disable {
        if session.nvenc_enabled.swap(false, Ordering::Relaxed) {
            crate::logger::log_msg("WARN", "capture.encoder", &format!("session={session_id} native H264 disabled by frontend decoder/transport; fallback=libjpeg-turbo/JPEG"));
            session
                .metrics
                .nvenc_fallbacks
                .fetch_add(1, Ordering::Relaxed);
        }
    } else if let Some(active) = consumers_active {
        let prev = session.consumers_active.swap(active, Ordering::AcqRel);
        if active && !prev {
            request_capture_keyframe(&session.nvenc_keyframe, &session.wgc_thread_id);
        }
    } else {
        request_capture_keyframe(&session.nvenc_keyframe, &session.wgc_thread_id);
    }
    Ok(())
}

fn send_paced_frame(
    frame: PacedFrame<Arc<Vec<u8>>>,
    sender: &broadcast::Sender<Message>,
    metrics: &CaptureMetrics,
) {
    let message = match frame {
        PacedFrame::Fresh { frame, age_us } => {
            metrics.paced_images.fetch_add(1, Ordering::Relaxed);
            #[cfg(feature = "media-diagnostics")]
            diagnostic_tick(&metrics.last_delivery_us, &metrics.max_delivery_gap_us);
            metrics.queue_age_us.fetch_add(age_us, Ordering::Relaxed);
            metrics
                .max_queue_age_us
                .fetch_max(age_us, Ordering::Relaxed);
            Message::Binary((*frame).clone())
        }
        PacedFrame::Refresh(frame) => {
            metrics.refresh_images.fetch_add(1, Ordering::Relaxed);
            Message::Binary((*frame).clone())
        }
        PacedFrame::Repeat => {
            metrics.repeat_ticks.fetch_add(1, Ordering::Relaxed);
            Message::Binary(vec![0])
        }
    };
    let _ = sender.send(message);
}

fn enqueue_capture_frame(
    delivery: &FrameDelivery,
    frame: Arc<Vec<u8>>,
    ready_us: u64,
    legacy: bool,
    active: &AtomicBool,
    sender: &broadcast::Sender<Message>,
    metrics: &CaptureMetrics,
) -> bool {
    if !active.load(Ordering::Relaxed) {
        return false;
    }
    if let Ok(mut pacer) = delivery.0.lock() {
        if !active.load(Ordering::Acquire) {
            return false;
        }
        if legacy {
            pacer.record_immediate(frame.clone(), ready_us);
        } else if frame.starts_with(b"P2NV") {
            if !pacer.enqueue_dependent(frame.clone(), ready_us) {
                return false;
            }
        } else {
            pacer.enqueue(frame.clone(), ready_us);
        }
        if !legacy
            && (frame.starts_with(b"P2NV") || crate::remote_control::is_host_control_active())
        {
            pacer.deliver_now(ready_us);
        }
    } else {
        return false;
    }
    if legacy && active.load(Ordering::Relaxed) {
        send_paced_frame(PacedFrame::Fresh { frame, age_us: 0 }, sender, metrics);
    }
    delivery.1.notify_one();
    true
}

fn start_frame_delivery(
    delivery: FrameDelivery,
    active: Arc<AtomicBool>,
    load: Arc<crate::video_load::CaptureLoad>,
    sender: broadcast::Sender<Message>,
    metrics: Arc<CaptureMetrics>,
    started: std::time::Instant,
    consumers_active: Arc<AtomicBool>,
    native_route_count: Arc<AtomicUsize>,
) {
    std::thread::spawn(move || {
        let _timer_guard = MultimediaTimerGuard::new();
        while active.load(Ordering::Relaxed) {
            if !consumers_active.load(Ordering::Relaxed)
                && native_route_count.load(Ordering::Relaxed) == 0
                && metrics.images.load(Ordering::Relaxed) > 0
            {
                if let Ok(pacer) = delivery.0.lock() {
                    let _ = delivery
                        .1
                        .wait_timeout(pacer, std::time::Duration::from_millis(100));
                } else {
                    break;
                }
                continue;
            }
            let now_us = started.elapsed().as_micros() as u64;
            let output = if let Ok(mut pacer) = delivery.0.lock() {
                pacer.set_fps(load.fps(), now_us);
                let output = pacer.tick(now_us);
                metrics.queue_drops.store(pacer.dropped, Ordering::Relaxed);
                metrics
                    .missed_deadlines
                    .store(pacer.missed, Ordering::Relaxed);
                output
            } else {
                break;
            };
            if let Some(frame) = output {
                if !active.load(Ordering::Relaxed) {
                    break;
                }
                send_paced_frame(frame, &sender, &metrics);
            }
            if let Ok(pacer) = delivery.0.lock() {
                let now_us = started.elapsed().as_micros() as u64;
                let wait_us = pacer
                    .next_tick_us()
                    .map_or(16_000, |deadline| deadline.saturating_sub(now_us))
                    .min(16_000);
                if wait_us > 0 {
                    // Notifications wake the waiter for new data; they never advance its deadline.
                    let _wait = delivery
                        .1
                        .wait_timeout(pacer, std::time::Duration::from_micros(wait_us));
                }
            } else {
                break;
            }
        }
    });
}

#[derive(Clone)]
pub struct CaptureFlags {
    lifecycle: Arc<CaptureLifecycle>,
    prefer_dxgi: Arc<AtomicBool>,
    nvenc_sequence: Arc<std::sync::atomic::AtomicU32>,
    try_nvenc: bool,
    try_mf: bool,
    pub session_id: String,
    pub nvenc_enabled: Arc<AtomicBool>,
    pub nvenc_keyframe: Arc<AtomicBool>,
    nvenc_bitrate: Arc<std::sync::atomic::AtomicU32>,
    consumers_active: Arc<AtomicBool>,
    native_route_count: Arc<AtomicUsize>,
    pub delivery: FrameDelivery,
    pub legacy_pacing: bool,
    pub load: Arc<crate::video_load::CaptureLoad>,
    pub sender: broadcast::Sender<Message>,
    pub target_fps: u32,
    pub target_width: u32,
    pub target_height: u32,
    pub quality: u8,
    pub active_flag: Arc<AtomicBool>,
    pub start_instant: std::time::Instant,
    pub metrics: Arc<CaptureMetrics>,
}

struct CaptureLifecycle {
    active: AtomicBool,
    closed: AtomicBool,
}
impl CaptureLifecycle {
    fn new() -> Self {
        Self {
            active: AtomicBool::new(true),
            closed: AtomicBool::new(false),
        }
    }
}

#[cfg(windows)]
pub struct NativeWgcHandler {
    lifecycle: Arc<CaptureLifecycle>,
    session_id: String,
    try_nvenc: bool,
    try_mf: bool,
    nvenc_sequence: Arc<std::sync::atomic::AtomicU32>,
    nvenc: Option<crate::video_hardware::GpuEncoder>,
    nvenc_enabled: Arc<AtomicBool>,
    nvenc_keyframe: Arc<AtomicBool>,
    nvenc_bitrate: Arc<std::sync::atomic::AtomicU32>,
    consumers_active: Arc<AtomicBool>,
    native_route_count: Arc<AtomicUsize>,
    consecutive_hw_timeouts: u8,
    last_encoded: Option<(
        windows_capture_api::Win32::Graphics::Direct3D11::ID3D11Texture2D,
        u32,
        u32,
    )>,
    refinements_remaining: u8,
    last_hw_encode: Option<std::time::Instant>,
    delivery: FrameDelivery,
    legacy_pacing: bool,
    load: Arc<crate::video_load::CaptureLoad>,
    load_controller: crate::video_load::LoadController,
    sender: broadcast::Sender<Message>,
    target_width: u32,
    target_height: u32,
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
    start_instant: std::time::Instant,
    metrics: Arc<CaptureMetrics>,
}

#[cfg(windows)]
type CaptureError = Box<dyn std::error::Error + Send + Sync>;

#[cfg(windows)]
impl NativeWgcHandler {
    fn from_flags(flags: CaptureFlags) -> Result<Self, CaptureError> {
        flags.metrics.capture_backend.store(1, Ordering::Relaxed);
        let fps = flags.target_fps.clamp(15, 120);
        let frame_interval = std::time::Duration::from_nanos(1_000_000_000 / fps as u64);
        Ok(Self {
            lifecycle: flags.lifecycle,
            session_id: flags.session_id,
            try_nvenc: flags.try_nvenc,
            try_mf: flags.try_mf,
            nvenc_sequence: flags.nvenc_sequence.clone(),
            nvenc: Some(crate::video_hardware::GpuEncoder::new(
                flags.try_nvenc,
                flags.try_mf,
                flags.nvenc_sequence,
            )),
            nvenc_enabled: flags.nvenc_enabled,
            nvenc_keyframe: flags.nvenc_keyframe,
            nvenc_bitrate: flags.nvenc_bitrate,
            consumers_active: flags.consumers_active,
            native_route_count: flags.native_route_count,
            consecutive_hw_timeouts: 0,
            last_encoded: None,
            refinements_remaining: 0,
            last_hw_encode: None,
            delivery: flags.delivery,
            legacy_pacing: flags.legacy_pacing,
            load: flags.load,
            load_controller: crate::video_load::LoadController::default(),
            sender: flags.sender,
            target_width: flags.target_width,
            target_height: flags.target_height,
            raw_buffer: Vec::new(),
            readback: crate::video_readback::ReusableReadback::default(),
            legacy_readback: std::env::var("P2SHARER_LEGACY_VIDEO_READBACK").as_deref() == Ok("1"),
            consecutive_readback_errors: 0,
            gpu_scaler: crate::video_gpu_scale::GpuScaler::default(),
            gpu_scaling_disabled: false,
            resized_image: None,
            resizer: fast_image_resize::Resizer::new(),
            jpeg_encoder: RealtimeJpegEncoder::new(flags.quality)?,
            next_frame_time: std::time::Instant::now(),
            frame_interval,
            start_instant: flags.start_instant,
            metrics: flags.metrics,
        })
    }

    fn on_closed(&mut self) {
        crate::logger::log_msg(
            "WARN",
            "capture.source",
            &format!(
                "session={} WGC source closed elapsed_ms={}",
                self.session_id,
                self.start_instant.elapsed().as_millis()
            ),
        );
        // A monitor's WGC item can close during a secure desktop transition.
        // The supervisor confirms source loss or recreates capture after returning.
        self.lifecycle.closed.store(true, Ordering::Release);
    }

    fn has_active_consumers(&self) -> bool {
        self.consumers_active.load(Ordering::Relaxed)
            || self.native_route_count.load(Ordering::Relaxed) > 0
            || self.metrics.images.load(Ordering::Relaxed) == 0
    }

    #[allow(clippy::too_many_arguments)]
    fn process_texture(
        &mut self,
        device: &windows_capture_api::Win32::Graphics::Direct3D11::ID3D11Device,
        context: &windows_capture_api::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
        texture: &windows_capture_api::Win32::Graphics::Direct3D11::ID3D11Texture2D,
        width: u32,
        height: u32,
        legacy: Option<&mut windows_capture::frame::Frame<'_>>,
    ) -> Result<(), CaptureError> {
        let legacy_unavailable = legacy.is_none();
        if legacy_unavailable {
            self.legacy_readback = false;
        }
        // Keep the target cadence across callback jitter and non-matching refresh rates.
        // Resetting the gate after each frame can halve 60 FPS capture on a 75 Hz display.
        let arrival_time = std::time::Instant::now();
        self.frame_interval =
            std::time::Duration::from_nanos(1_000_000_000 / u64::from(self.load.fps()));
        self.metrics.callbacks.fetch_add(1, Ordering::Relaxed);
        #[cfg(feature = "media-diagnostics")]
        diagnostic_tick(
            &self.metrics.last_callback_us,
            &self.metrics.max_callback_gap_us,
        );
        if !self.has_active_consumers() {
            self.refinements_remaining = 0;
            self.metrics.gated.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }
        // Allow a 2 ms callback jitter tolerance for native hardware encoding so display VSync
        // phase skew does not unnecessarily discard nearly on-time frames.
        let early_margin = if self.nvenc_enabled.load(Ordering::Relaxed) {
            std::time::Duration::from_millis(2).min(self.frame_interval / 4)
        } else {
            std::time::Duration::ZERO
        };
        if arrival_time + early_margin < self.next_frame_time {
            self.metrics.gated.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }

        let mut src_width = width;
        let mut src_height = height;
        if src_width == 0 || src_height == 0 {
            return Ok(());
        }

        (self.target_width, self.target_height) = self.load.bounds(src_width, src_height);

        let hw_encode_enabled = self.nvenc_enabled.load(Ordering::Relaxed);
        let scaled = if !self.legacy_readback
            && !self.gpu_scaling_disabled
            && self.target_width > 0
            && self.target_height > 0
            && (src_width > self.target_width
                || src_height > self.target_height
                || (hw_encode_enabled
                    && src_width >= 2
                    && src_height >= 2
                    && (src_width % 2 != 0 || src_height % 2 != 0)))
        {
            let (mut width, mut height) = if src_width > self.target_width
                || src_height > self.target_height
            {
                fit_capture_dimensions(src_width, src_height, self.target_width, self.target_height)
            } else {
                (src_width, src_height)
            };
            if hw_encode_enabled && width >= 2 && height >= 2 {
                width &= !1;
                height &= !1;
            }
            match self
                .gpu_scaler
                .resize(device, context, texture, width, height)
            {
                Ok(texture) => {
                    src_width = width;
                    src_height = height;
                    Some(texture)
                }
                Err(error) => {
                    self.gpu_scaling_disabled = true;
                    crate::logger::log_msg("WARN", "capture.scaling", &format!("session={} GPU downscaling failed; fallback=CPU resize error={error:?}", self.session_id));
                    None
                }
            }
        } else {
            None
        };
        if hw_encode_enabled
            && (scaled.is_some()
                || (src_width <= self.target_width && src_height <= self.target_height))
        {
            // There is only one producer per capture. Check admission before
            // NVENC advances its reference chain; the delivery thread only removes.
            if !self.legacy_pacing
                && !self
                    .delivery
                    .0
                    .lock()
                    .map_or(false, |pacer| pacer.has_encode_capacity())
            {
                self.metrics.gated.fetch_add(1, Ordering::Relaxed);
                return Ok(());
            }
            let encoder_started = std::time::Instant::now();
            let result = self
                .nvenc
                .as_mut()
                .ok_or_else(|| "Native encoder was retired".to_string())
                .and_then(|encoder| {
                    encoder.encode(
                        device,
                        scaled.as_ref().unwrap_or(texture),
                        src_width,
                        src_height,
                        self.load.fps(),
                        self.nvenc_bitrate.load(Ordering::Relaxed),
                        self.start_instant.elapsed().as_micros() as u64,
                        self.nvenc_keyframe.swap(false, Ordering::Relaxed),
                    )
                });
            self.metrics.nvenc_us.fetch_add(
                encoder_started.elapsed().as_micros() as u64,
                Ordering::Relaxed,
            );
            match result {
                Ok(bytes) => {
                    self.consecutive_hw_timeouts = 0;
                    log_selected_encoder(
                        &self.metrics,
                        &self.session_id,
                        self.nvenc.as_ref().unwrap().backend(),
                        src_width,
                        src_height,
                        self.load.fps(),
                        self.start_instant.elapsed().as_millis(),
                    );
                    self.next_frame_time += self.frame_interval;
                    if arrival_time.saturating_duration_since(self.next_frame_time)
                        >= self.frame_interval
                    {
                        self.next_frame_time = arrival_time + self.frame_interval;
                    }
                    self.load.output(src_width, src_height);
                    self.metrics.images.fetch_add(1, Ordering::Relaxed);
                    self.metrics.nvenc_images.fetch_add(1, Ordering::Relaxed);
                    if scaled.is_some() {
                        self.metrics
                            .gpu_scaled_images
                            .fetch_add(1, Ordering::Relaxed);
                    }
                    let encode_us = encoder_started.elapsed().as_micros() as u64;
                    let frame_budget_us = self.frame_interval.as_micros() as u64;
                    if !enqueue_capture_frame(
                        &self.delivery,
                        Arc::new(bytes),
                        self.start_instant.elapsed().as_micros() as u64,
                        self.legacy_pacing,
                        &self.lifecycle.active,
                        &self.sender,
                        &self.metrics,
                    ) {
                        self.nvenc_keyframe.store(true, Ordering::Relaxed);
                        self.refinements_remaining = 0;
                    } else if copy_refine_texture(
                        device,
                        context,
                        scaled.as_ref().unwrap_or(texture),
                        src_width,
                        src_height,
                        &mut self.last_encoded,
                    ) {
                        self.last_hw_encode = Some(arrival_time);
                        // Skip static refinement passes when hardware encoding is slow or overloaded.
                        self.refinements_remaining = if encode_us.saturating_mul(2)
                            < frame_budget_us
                            && self.load.snapshot().reason != "native_processing"
                        {
                            8
                        } else {
                            0
                        };
                    } else {
                        self.refinements_remaining = 0;
                    }
                    let processing_us = arrival_time.elapsed().as_micros() as u64;
                    self.metrics
                        .processing_us
                        .fetch_add(processing_us, Ordering::Relaxed);
                    self.load_controller
                        .observe(&self.load, self.load.elapsed_ms(), processing_us);
                    return Ok(());
                }
                Err(error) => {
                    let is_timeout = error.contains("timeout") || error.contains("WAIT_TIMEOUT");
                    if is_timeout && self.consecutive_hw_timeouts < 2 {
                        self.consecutive_hw_timeouts += 1;
                        self.nvenc = Some(crate::video_hardware::GpuEncoder::new(
                            self.try_nvenc,
                            self.try_mf,
                            self.nvenc_sequence.clone(),
                        ));
                        self.nvenc_keyframe.store(true, Ordering::Relaxed);
                        self.last_encoded = None;
                        self.refinements_remaining = 0;
                        crate::logger::log_msg("WARN", "capture.hardware", &format!(
                            "session={} transient hardware encode timeout ({}/3) output={src_width}x{src_height} fps={} attempt_ms={} retrying_hw error={error}",
                            self.session_id, self.consecutive_hw_timeouts, self.load.fps(), encoder_started.elapsed().as_millis()));
                        return Ok(());
                    }
                    self.nvenc_enabled.store(false, Ordering::Relaxed);
                    self.metrics.nvenc_fallbacks.fetch_add(1, Ordering::Relaxed);
                    self.nvenc = None;
                    self.last_encoded = None;
                    self.refinements_remaining = 0;
                    crate::logger::log_msg("WARN", "capture.hardware", &format!("session={} hardware encode/init failed output={src_width}x{src_height} fps={} attempt_ms={} elapsed_ms={} fallback=libjpeg-turbo/JPEG error={error}",
                        self.session_id, self.load.fps(), encoder_started.elapsed().as_millis(), self.start_instant.elapsed().as_millis()));
                }
            }
        } else {
            if self.nvenc_enabled.swap(false, Ordering::Relaxed) {
                crate::logger::log_msg("WARN", "capture.hardware", &format!("session={} native H264 disabled: GPU scaling unavailable for source bounds; fallback=libjpeg-turbo/JPEG", self.session_id));
                self.metrics.nvenc_fallbacks.fetch_add(1, Ordering::Relaxed);
            }
            // A decoder rejection releases the driver session on its owner thread.
            self.nvenc = None;
        }
        let mut frame_buffer = match if self.legacy_readback && legacy.is_some() {
            legacy
                .unwrap()
                .buffer()
                .map(crate::video_readback::CapturePixels::Legacy)
                .map_err(|error| -> CaptureError { error.into() })
        } else {
            self.readback
                .read_texture(device, context, scaled.as_ref().unwrap_or(texture))
                .map(crate::video_readback::CapturePixels::Reused)
                .map_err(|error| -> CaptureError { error.into() })
        } {
            Ok(buf) => buf,
            Err(_e) => {
                let failures = self.metrics.readback_errors.fetch_add(1, Ordering::Relaxed) + 1;
                if failures.is_power_of_two() {
                    crate::logger::log_msg(
                        "WARN",
                        "capture.readback",
                        &format!(
                            "session={} failures={failures} legacy={} error={_e:?}",
                            self.session_id, self.legacy_readback
                        ),
                    );
                }
                self.consecutive_readback_errors =
                    self.consecutive_readback_errors.saturating_add(1);
                if !self.legacy_readback && self.consecutive_readback_errors >= 3 {
                    self.legacy_readback = true;
                    crate::logger::log_msg("WARN", "capture.readback", &format!("session={} reusable GPU readback failed three times; fallback=legacy readback error={_e:?}", self.session_id));
                }
                if legacy_unavailable && self.consecutive_readback_errors >= 3 {
                    return Err(_e);
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
        let (pixel_data, pixel_pitch) =
            frame_buffer.strided(&mut self.raw_buffer, src_width, src_height, should_resize);
        self.metrics
            .readback_us
            .fetch_add(arrival_time.elapsed().as_micros() as u64, Ordering::Relaxed);
        let resize_start = std::time::Instant::now();
        let (final_pixels, final_w, final_h, final_pitch) = if should_resize {
            use fast_image_resize::images::{Image, ImageRef};
            use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions};

            if let Ok(src_img) = ImageRef::new(src_width, src_height, pixel_data, PixelType::U8x4) {
                let (dst_w, dst_h) = fit_capture_dimensions(
                    src_width,
                    src_height,
                    self.target_width,
                    self.target_height,
                );

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
        self.metrics
            .resize_us
            .fetch_add(resize_start.elapsed().as_micros() as u64, Ordering::Relaxed);

        let encode_start = std::time::Instant::now();
        match self
            .jpeg_encoder
            .encode_rgba_strided(final_pixels, final_w, final_h, final_pitch)
        {
            Ok(frame_bytes) => {
                log_selected_encoder(
                    &self.metrics,
                    &self.session_id,
                    2,
                    final_w,
                    final_h,
                    self.load.fps(),
                    self.start_instant.elapsed().as_millis(),
                );
                self.load.output(final_w, final_h);
                if scaled.is_some() {
                    self.metrics
                        .gpu_scaled_images
                        .fetch_add(1, Ordering::Relaxed);
                }
                self.metrics.images.fetch_add(1, Ordering::Relaxed);
                let frame_arc = Arc::new(frame_bytes);
                enqueue_capture_frame(
                    &self.delivery,
                    frame_arc,
                    self.start_instant.elapsed().as_micros() as u64,
                    self.legacy_pacing,
                    &self.lifecycle.active,
                    &self.sender,
                    &self.metrics,
                );
            }
            Err(error) => {
                let failures = self.metrics.jpeg_errors.fetch_add(1, Ordering::Relaxed) + 1;
                if failures.is_power_of_two() {
                    crate::logger::log_msg("ERROR", "capture.jpeg", &format!("session={} failures={failures} output={final_w}x{final_h} error={error:?}", self.session_id));
                }
            }
        }

        self.metrics
            .jpeg_us
            .fetch_add(encode_start.elapsed().as_micros() as u64, Ordering::Relaxed);
        drop(frame_buffer);
        if self.legacy_readback {
            self.metrics
                .staging_allocations
                .fetch_add(1, Ordering::Relaxed);
        } else {
            self.metrics
                .staging_allocations
                .store(self.readback.allocations(), Ordering::Relaxed);
        }
        let processing_us = arrival_time.elapsed().as_micros() as u64;
        self.metrics
            .processing_us
            .fetch_add(processing_us, Ordering::Relaxed);
        self.load_controller
            .observe(&self.load, self.load.elapsed_ms(), processing_us);

        Ok(())
    }

    fn refine_idle(
        &mut self,
        device: &windows_capture_api::Win32::Graphics::Direct3D11::ID3D11Device,
    ) -> bool {
        if self.refinements_remaining == 0
            || !self.nvenc_enabled.load(Ordering::Relaxed)
            || !self.lifecycle.active.load(Ordering::Relaxed)
            || !self.has_active_consumers()
        {
            self.refinements_remaining = 0;
            return false;
        }
        let Some(last) = self.last_hw_encode else {
            self.refinements_remaining = 0;
            return false;
        };
        if last.elapsed() < std::time::Duration::from_millis(35) {
            return true;
        }
        if !self.legacy_pacing
            && !self
                .delivery
                .0
                .lock()
                .map_or(false, |pacer| pacer.has_encode_capacity())
        {
            if last.elapsed() > std::time::Duration::from_millis(350) {
                self.refinements_remaining = 0;
                return false;
            }
            return true;
        }
        let Some((texture, width, height)) = self
            .last_encoded
            .as_ref()
            .map(|(t, w, h)| (t.clone(), *w, *h))
        else {
            self.refinements_remaining = 0;
            return false;
        };
        let Some(encoder) = self.nvenc.as_mut() else {
            self.refinements_remaining = 0;
            return false;
        };
        match encoder.encode(
            device,
            &texture,
            width,
            height,
            self.load.fps(),
            self.nvenc_bitrate.load(Ordering::Relaxed),
            self.start_instant.elapsed().as_micros() as u64,
            self.nvenc_keyframe.swap(false, Ordering::AcqRel),
        ) {
            Ok(bytes) => {
                if !enqueue_capture_frame(
                    &self.delivery,
                    Arc::new(bytes),
                    self.start_instant.elapsed().as_micros() as u64,
                    self.legacy_pacing,
                    &self.lifecycle.active,
                    &self.sender,
                    &self.metrics,
                ) {
                    self.nvenc_keyframe.store(true, Ordering::Relaxed);
                    self.refinements_remaining = 0;
                    return false;
                }
                self.metrics.images.fetch_add(1, Ordering::Relaxed);
                self.metrics.nvenc_images.fetch_add(1, Ordering::Relaxed);
                self.last_hw_encode = Some(std::time::Instant::now());
                self.refinements_remaining = self.refinements_remaining.saturating_sub(1);
                self.refinements_remaining > 0
            }
            Err(_) => {
                self.refinements_remaining = 0;
                false
            }
        }
    }

    fn encode_requested_keyframe(
        &mut self,
        device: &windows_capture_api::Win32::Graphics::Direct3D11::ID3D11Device,
    ) {
        if !self.nvenc_keyframe.load(Ordering::Acquire)
            || !self.nvenc_enabled.load(Ordering::Relaxed)
            || !self.lifecycle.active.load(Ordering::Relaxed)
        {
            return;
        }
        if !self.legacy_pacing
            && !self
                .delivery
                .0
                .lock()
                .map_or(false, |pacer| pacer.has_encode_capacity())
        {
            return;
        }
        let Some((texture, width, height)) = self
            .last_encoded
            .as_ref()
            .map(|(t, w, h)| (t.clone(), *w, *h))
        else {
            return;
        };
        let Some(encoder) = self.nvenc.as_mut() else {
            return;
        };
        let force_keyframe = self.nvenc_keyframe.swap(false, Ordering::AcqRel);
        match encoder.encode(
            device,
            &texture,
            width,
            height,
            self.load.fps(),
            self.nvenc_bitrate.load(Ordering::Relaxed),
            self.start_instant.elapsed().as_micros() as u64,
            force_keyframe,
        ) {
            Ok(bytes) => {
                if !enqueue_capture_frame(
                    &self.delivery,
                    Arc::new(bytes),
                    self.start_instant.elapsed().as_micros() as u64,
                    self.legacy_pacing,
                    &self.lifecycle.active,
                    &self.sender,
                    &self.metrics,
                ) {
                    self.nvenc_keyframe.store(true, Ordering::Release);
                    return;
                }
                self.metrics.images.fetch_add(1, Ordering::Relaxed);
                self.metrics.nvenc_images.fetch_add(1, Ordering::Relaxed);
                self.last_hw_encode = Some(std::time::Instant::now());
            }
            Err(_) => {
                self.nvenc_keyframe.store(true, Ordering::Release);
            }
        }
    }
}

#[cfg(windows)]
fn copy_refine_texture(
    device: &windows_capture_api::Win32::Graphics::Direct3D11::ID3D11Device,
    context: &windows_capture_api::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
    source: &windows_capture_api::Win32::Graphics::Direct3D11::ID3D11Texture2D,
    width: u32,
    height: u32,
    cached: &mut Option<(
        windows_capture_api::Win32::Graphics::Direct3D11::ID3D11Texture2D,
        u32,
        u32,
    )>,
) -> bool {
    use windows_capture_api::Win32::Graphics::Direct3D11::{
        ID3D11Texture2D, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    };
    use windows_capture_api::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
    let mut src_desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { source.GetDesc(&mut src_desc) };
    let needs_alloc = cached
        .as_ref()
        .is_none_or(|(_, cw, ch)| *cw != width || *ch != height);
    if needs_alloc {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: src_desc.Format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            ..Default::default()
        };
        let mut copy: Option<ID3D11Texture2D> = None;
        if unsafe { device.CreateTexture2D(&desc, None, Some(&mut copy)) }.is_err() {
            *cached = None;
            return false;
        }
        *cached = copy.map(|tex| (tex, width, height));
    }
    if let Some((dst, _, _)) = cached.as_ref() {
        unsafe { context.CopyResource(dst, source) };
        true
    } else {
        false
    }
}

#[cfg(windows)]
const WM_APP_UPDATE_CURSOR: u32 = 0x8000 + 0x101;
#[cfg(windows)]
const WM_APP_ARM_REFINE: u32 = 0x8000 + 0x102;
#[cfg(windows)]
const WM_APP_REQUEST_KEYFRAME: u32 = 0x8000 + 0x103;

#[cfg(windows)]
struct WgcControl {
    halt: Arc<AtomicBool>,
    desired_cursor: Arc<AtomicBool>,
    thread_id: u32,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(windows)]
impl WgcControl {
    fn is_finished(&self) -> bool {
        self.thread
            .as_ref()
            .map_or(true, |thread| thread.is_finished())
    }

    fn set_cursor_visible(&self, visible: bool) {
        self.desired_cursor.store(visible, Ordering::Release);
        if self.thread_id != 0 && !self.is_finished() {
            unsafe {
                let _ = windows_capture_api::Win32::UI::WindowsAndMessaging::PostThreadMessageW(
                    self.thread_id,
                    WM_APP_UPDATE_CURSOR,
                    windows_capture_api::Win32::Foundation::WPARAM(usize::from(visible)),
                    windows_capture_api::Win32::Foundation::LPARAM(0),
                );
            }
        }
    }
}

#[cfg(windows)]
enum ActiveCaptureControl {
    Wgc(WgcControl),
    Dxgi {
        halt: Arc<AtomicBool>,
        thread: std::thread::JoinHandle<()>,
    },
}
#[cfg(windows)]
impl ActiveCaptureControl {
    fn is_finished(&self) -> bool {
        match self {
            Self::Wgc(control) => control.is_finished(),
            Self::Dxgi { thread, .. } => thread.is_finished(),
        }
    }
}

#[cfg(windows)]
fn start_gpu_capture(
    source: &str,
    capture_mouse: bool,
    mut flags: CaptureFlags,
) -> Result<(ActiveCaptureControl, Arc<CaptureLifecycle>), String> {
    if capture_mouse && source.starts_with("screen:") && flags.prefer_dxgi.load(Ordering::Acquire) {
        match start_dxgi_capture(source, capture_mouse, flags.clone()) {
            Ok(control) => return Ok((control, flags.lifecycle.clone())),
            Err(error) => {
                flags.prefer_dxgi.store(false, Ordering::Release);
                if !flags.lifecycle.active.load(Ordering::Acquire) {
                    flags.lifecycle = Arc::new(CaptureLifecycle::new());
                }
                flags.lifecycle.closed.store(false, Ordering::Release);
                crate::logger::log_msg(
                    "WARN",
                    "capture.dxgi",
                    &format!(
                        "session={} initialization failed; fallback=WGC error={error}",
                        flags.session_id
                    ),
                );
            }
        }
    }
    let lifecycle = flags.lifecycle.clone();
    start_wgc_capture(source, capture_mouse, flags)
        .map(|control| (ActiveCaptureControl::Wgc(control), lifecycle))
}

#[cfg(windows)]
fn start_dxgi_capture(
    source: &str,
    capture_mouse: bool,
    flags: CaptureFlags,
) -> Result<ActiveCaptureControl, String> {
    let index = source
        .strip_prefix("screen:")
        .ok_or("DXGI requires a monitor")?
        .parse::<usize>()
        .map_err(|e| e.to_string())?;
    let monitor = WgcMonitor::from_index(index + 1)
        .map_err(|e| e.to_string())?
        .as_raw_hmonitor() as usize;
    let halt = Arc::new(AtomicBool::new(false));
    let stopped = halt.clone();
    let (ready, started) = std::sync::mpsc::sync_channel(1);
    let lifecycle = flags.lifecycle.clone();
    let thread = std::thread::spawn(move || {
        let _timer = MultimediaTimerGuard::new();
        let result = (|| -> Result<(), CaptureError> {
            let mut capture = crate::video_dxgi::DesktopCapture::new(monitor, capture_mouse)?;
            let mut processor = NativeWgcHandler::from_flags(flags.clone())?;
            flags.metrics.capture_backend.store(2, Ordering::Relaxed);
            if ready.send(Ok(())).is_err() {
                return Ok(());
            }
            crate::logger::log_msg(
                "INFO",
                "capture.start",
                &format!(
                    "session={} backend=DXGI awaiting_first_frame=true",
                    flags.session_id
                ),
            );
            while !stopped.load(Ordering::Acquire)
                && flags.active_flag.load(Ordering::Acquire)
                && flags.lifecycle.active.load(Ordering::Acquire)
            {
                if let Some(texture) = capture.next_frame()? {
                    let (width, height) = capture.dimensions();
                    processor.process_texture(
                        capture.device(),
                        capture.context(),
                        &texture,
                        width,
                        height,
                        None,
                    )?;
                } else {
                    processor.refine_idle(capture.device());
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            // A lost duplication can follow a mode/desktop switch. Recreate it through
            // the existing recovery supervisor; other failures retain WGC compatibility.
            let lost = error
                .downcast_ref::<windows_capture_api::core::Error>()
                .is_some_and(|error| {
                    error.code()
                        == windows_capture_api::Win32::Graphics::Dxgi::DXGI_ERROR_ACCESS_LOST
                });
            if !lost {
                flags.prefer_dxgi.store(false, Ordering::Release);
            }
            let message = error.to_string();
            let _ = ready.try_send(Err(message.clone()));
            crate::logger::log_msg(
                "WARN",
                "capture.dxgi",
                &format!(
                    "session={} capture stopped access_lost={lost} error={message}",
                    flags.session_id
                ),
            );
        }
        flags.lifecycle.closed.store(true, Ordering::Release);
    });
    match started.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(())) => Ok(ActiveCaptureControl::Dxgi { halt, thread }),
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(error)
        }
        _ => {
            halt.store(true, Ordering::Release);
            // A slow driver must never retain permission to publish into the WGC replacement.
            lifecycle.active.store(false, Ordering::Release);
            Err("DXGI startup timed out".into())
        }
    }
}

#[cfg(windows)]
struct WgcWinRtGuard {
    cookie: windows_capture_api::Win32::System::Com::CO_MTA_USAGE_COOKIE,
}

#[cfg(windows)]
impl WgcWinRtGuard {
    fn new() -> Result<Self, String> {
        use windows_capture_api::Win32::{
            Foundation::S_FALSE,
            System::{
                Com::CoIncrementMTAUsage,
                WinRT::{RoInitialize, RO_INIT_MULTITHREADED},
            },
        };
        let cookie = unsafe { CoIncrementMTAUsage().map_err(|e| e.to_string())? };
        if let Err(err) = unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
            if err.code() != S_FALSE {
                unsafe {
                    let _ = windows_capture_api::Win32::System::Com::CoDecrementMTAUsage(cookie);
                }
                return Err(err.to_string());
            }
        }
        Ok(Self { cookie })
    }
}

#[cfg(windows)]
impl Drop for WgcWinRtGuard {
    fn drop(&mut self) {
        unsafe {
            windows_capture_api::Win32::System::WinRT::RoUninitialize();
            let _ = windows_capture_api::Win32::System::Com::CoDecrementMTAUsage(self.cookie);
        }
    }
}

#[cfg(windows)]
fn apply_wgc_cursor_visibility(
    session: &windows_capture_api::Graphics::Capture::GraphicsCaptureSession,
    metrics: &CaptureMetrics,
    applied: &AtomicBool,
    desired: bool,
    session_id: &str,
) {
    if applied.load(Ordering::Acquire) == desired {
        return;
    }
    if session.SetIsCursorCaptureEnabled(desired).is_ok() {
        applied.store(desired, Ordering::Release);
        metrics.cursor_embedded.store(desired, Ordering::Release);
        crate::logger::log_msg(
            "INFO",
            "capture.cursor",
            &format!("session={session_id} cursor_embedded={desired} mode=in_place"),
        );
    }
}

#[cfg(windows)]
fn start_wgc_capture(
    source: &str,
    capture_mouse: bool,
    flags: CaptureFlags,
) -> Result<WgcControl, String> {
    use std::sync::atomic::AtomicI32;
    use windows_capture::d3d11::{create_d3d_device, create_direct3d_device, SendDirectX};
    use windows_capture::graphics_capture_api::GraphicsCaptureApi;
    use windows_capture_api::core::{IInspectable, Interface};
    use windows_capture_api::Foundation::TypedEventHandler;
    use windows_capture_api::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
    use windows_capture_api::Graphics::DirectX::DirectXPixelFormat;
    use windows_capture_api::Win32::Foundation::{LPARAM, WPARAM};
    use windows_capture_api::Win32::Graphics::Direct3D11::{ID3D11Texture2D, D3D11_TEXTURE2D_DESC};
    use windows_capture_api::Win32::System::Threading::GetCurrentThreadId;
    use windows_capture_api::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
    use windows_capture_api::Win32::System::WinRT::{
        CreateDispatcherQueueController, DispatcherQueueOptions, DQTAT_COM_NONE,
        DQTYPE_THREAD_CURRENT,
    };
    use windows_capture_api::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, KillTimer, PostQuitMessage, PostThreadMessageW, SetTimer,
        TranslateMessage, MSG, WM_QUIT, WM_TIMER,
    };

    let cursor_supported = GraphicsCaptureApi::is_cursor_settings_supported().unwrap_or(false);
    let border_supported = GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false);
    let interval_supported =
        GraphicsCaptureApi::is_minimum_update_interval_supported().unwrap_or(false);
    let effective_mouse =
        capture_mouse && !crate::remote_control::should_suppress_captured_cursor();
    let (cursor, border) =
        capture_visual_settings(effective_mouse, cursor_supported, border_supported);
    let embedded = if cursor_supported {
        effective_mouse
    } else {
        capture_mouse
    };
    flags
        .metrics
        .cursor_embedded
        .store(embedded, Ordering::Release);
    crate::logger::log_msg("INFO", "capture.compatibility", &format!(
        "session={} cursor_configurable={cursor_supported} border_configurable={border_supported} cursor={cursor:?} border={border:?}", flags.session_id));

    let (kind, raw) = source.split_once(':').ok_or("Invalid capture source")?;
    enum TargetSource {
        Window(usize),
        Monitor(usize),
    }
    let target = if kind == "window" {
        let hwnd = raw.parse::<usize>().map_err(|e| e.to_string())?;
        let window = WgcWindow::from_raw_hwnd(hwnd as *mut std::ffi::c_void);
        // The picker excludes tool windows; the app-owned browser intentionally uses one.
        let mut pid = 0;
        let browser_source = flags.session_id.starts_with("browser-")
            && unsafe {
                let hwnd = windows::Win32::Foundation::HWND(hwnd as *mut std::ffi::c_void);
                windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(
                    hwnd,
                    Some(&mut pid),
                );
                pid == std::process::id()
                    && windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(hwnd).as_bool()
            };
        if !window.is_valid() && !browser_source {
            return Err("Capture window no longer exists".into());
        }
        TargetSource::Window(hwnd)
    } else {
        let index = raw.parse::<usize>().map_err(|e| e.to_string())?;
        let _ = WgcMonitor::from_index(index + 1).map_err(|e| e.to_string())?;
        TargetSource::Monitor(index)
    };

    let halt = Arc::new(AtomicBool::new(false));
    let desired_cursor = Arc::new(AtomicBool::new(embedded));
    let halt_thread = halt.clone();
    let desired_thread = desired_cursor.clone();
    let (ready, started) = std::sync::mpsc::sync_channel::<Result<u32, String>>(1);

    let thread = std::thread::spawn(move || {
        let _winrt = match WgcWinRtGuard::new() {
            Ok(guard) => guard,
            Err(err) => {
                let _ = ready.try_send(Err(err));
                return;
            }
        };

        let controller = match unsafe {
            CreateDispatcherQueueController(DispatcherQueueOptions {
                dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
                threadType: DQTYPE_THREAD_CURRENT,
                apartmentType: DQTAT_COM_NONE,
            })
        } {
            Ok(controller) => controller,
            Err(err) => {
                let _ = ready.try_send(Err(err.to_string()));
                return;
            }
        };

        let thread_id = unsafe { GetCurrentThreadId() };
        let (d3d_device, d3d_context) = match create_d3d_device() {
            Ok(pair) => pair,
            Err(err) => {
                let _ = ready.try_send(Err(err.to_string()));
                return;
            }
        };
        let direct3d_device = match create_direct3d_device(&d3d_device) {
            Ok(dev) => dev,
            Err(err) => {
                let _ = ready.try_send(Err(err.to_string()));
                return;
            }
        };

        let item_type: GraphicsCaptureItemType = match target {
            TargetSource::Window(hwnd) => {
                match WgcWindow::from_raw_hwnd(hwnd as *mut std::ffi::c_void).try_into() {
                    Ok(item) => item,
                    Err(err) => {
                        let _ = ready.try_send(Err(format!("{err:?}")));
                        return;
                    }
                }
            }
            TargetSource::Monitor(index) => match WgcMonitor::from_index(index + 1) {
                Ok(mon) => match mon.try_into() {
                    Ok(item) => item,
                    Err(err) => {
                        let _ = ready.try_send(Err(format!("{err:?}")));
                        return;
                    }
                },
                Err(err) => {
                    let _ = ready.try_send(Err(err.to_string()));
                    return;
                }
            },
        };
        let item = match &item_type {
            GraphicsCaptureItemType::Window((item, _))
            | GraphicsCaptureItemType::Monitor((item, _))
            | GraphicsCaptureItemType::Unknown((item, _)) => item.clone(),
        };

        let session_id = flags.session_id.clone();
        let metrics = flags.metrics.clone();
        let active_flag = flags.active_flag.clone();
        let lifecycle = flags.lifecycle.clone();
        let handler = match NativeWgcHandler::from_flags(flags) {
            Ok(handler) => Arc::new(std::sync::Mutex::new(handler)),
            Err(err) => {
                let _ = ready.try_send(Err(err.to_string()));
                return;
            }
        };

        let initial_size = match item.Size() {
            Ok(size) => size,
            Err(err) => {
                let _ = ready.try_send(Err(err.to_string()));
                return;
            }
        };
        let frame_pool = match Direct3D11CaptureFramePool::Create(
            &direct3d_device,
            DirectXPixelFormat::R8G8B8A8UIntNormalized,
            1,
            initial_size,
        ) {
            Ok(pool) => Arc::new(pool),
            Err(err) => {
                let _ = ready.try_send(Err(err.to_string()));
                return;
            }
        };
        let session = match frame_pool.CreateCaptureSession(&item) {
            Ok(session) => session,
            Err(err) => {
                let _ = frame_pool.Close();
                let _ = ready.try_send(Err(err.to_string()));
                return;
            }
        };

        if cursor_supported {
            if let Err(err) = session.SetIsCursorCaptureEnabled(effective_mouse) {
                let _ = session.Close();
                let _ = frame_pool.Close();
                let _ = ready.try_send(Err(err.to_string()));
                return;
            }
        }
        if border_supported {
            if let Err(err) = session.SetIsBorderRequired(false) {
                let _ = session.Close();
                let _ = frame_pool.Close();
                let _ = ready.try_send(Err(err.to_string()));
                return;
            }
        }
        if interval_supported {
            if let MinimumUpdateIntervalSettings::Custom(duration) = capture_update_interval() {
                let _ = session.SetMinUpdateInterval(duration.into());
            }
        }

        let closed_token = match item.Closed(
            &TypedEventHandler::<GraphicsCaptureItem, IInspectable>::new({
                let handler_closed = handler.clone();
                let halt_closed = halt_thread.clone();
                move |_, _| {
                    halt_closed.store(true, Ordering::Relaxed);
                    if let Ok(mut guard) = handler_closed.lock() {
                        guard.on_closed();
                    }
                    unsafe {
                        let _ = PostThreadMessageW(
                            thread_id,
                            WM_QUIT,
                            WPARAM::default(),
                            LPARAM::default(),
                        );
                    }
                    Ok(())
                }
            }),
        ) {
            Ok(token) => token,
            Err(err) => {
                let _ = session.Close();
                let _ = frame_pool.Close();
                let _ = ready.try_send(Err(err.to_string()));
                return;
            }
        };

        let applied_cursor = Arc::new(AtomicBool::new(embedded));
        let last_size = Arc::new((
            AtomicI32::new(initial_size.Width),
            AtomicI32::new(initial_size.Height),
        ));
        let direct3d_recreate = SendDirectX::new(direct3d_device);
        let frame_pool_recreate = SendDirectX::new(frame_pool.clone());
        let session_fp = SendDirectX::new(session.clone());
        let d3d_device_fp = SendDirectX::new(d3d_device.clone());
        let d3d_context_fp = SendDirectX::new(d3d_context.clone());
        let halt_fp = halt_thread.clone();
        let desired_fp = desired_thread.clone();
        let applied_fp = applied_cursor.clone();
        let metrics_fp = metrics.clone();
        let session_id_fp = session_id.clone();
        let handler_fp = handler.clone();

        let frame_token =
            match frame_pool.FrameArrived(&TypedEventHandler::<
                Direct3D11CaptureFramePool,
                IInspectable,
            >::new(move |pool, _| {
                let (
                    direct3d_recreate,
                    frame_pool_recreate,
                    session_fp,
                    d3d_device_fp,
                    d3d_context_fp,
                ) = (
                    &direct3d_recreate,
                    &frame_pool_recreate,
                    &session_fp,
                    &d3d_device_fp,
                    &d3d_context_fp,
                );
                if halt_fp.load(Ordering::Relaxed)
                    || !active_flag.load(Ordering::Relaxed)
                    || !lifecycle.active.load(Ordering::Relaxed)
                {
                    halt_fp.store(true, Ordering::Relaxed);
                    unsafe {
                        let _ = PostThreadMessageW(
                            thread_id,
                            WM_QUIT,
                            WPARAM::default(),
                            LPARAM::default(),
                        );
                    }
                    return Ok(());
                }
                if cursor_supported {
                    let desired = desired_fp.load(Ordering::Acquire);
                    apply_wgc_cursor_visibility(
                        &session_fp.0,
                        &metrics_fp,
                        &applied_fp,
                        desired,
                        &session_id_fp,
                    );
                }
                let Some(pool) = pool.as_ref() else {
                    return Ok(());
                };
                let frame = pool.TryGetNextFrame()?;
                let content_size = frame.ContentSize()?;
                if content_size.Width <= 0 || content_size.Height <= 0 {
                    return Ok(());
                }
                if content_size.Width != last_size.0.load(Ordering::Relaxed)
                    || content_size.Height != last_size.1.load(Ordering::Relaxed)
                {
                    drop(frame);
                    frame_pool_recreate.0.Recreate(
                        &direct3d_recreate.0,
                        DirectXPixelFormat::R8G8B8A8UIntNormalized,
                        1,
                        content_size,
                    )?;
                    last_size.0.store(content_size.Width, Ordering::Relaxed);
                    last_size.1.store(content_size.Height, Ordering::Relaxed);
                    return Ok(());
                }
                let surface = frame.Surface()?;
                let dxgi_access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
                let texture: ID3D11Texture2D = unsafe { dxgi_access.GetInterface()? };
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                unsafe { texture.GetDesc(&mut desc) };
                let (result, arm_refine) = match handler_fp.lock() {
                    Ok(mut guard) => {
                        let res = guard.process_texture(
                            &d3d_device_fp.0,
                            &d3d_context_fp.0,
                            &texture,
                            desc.Width,
                            desc.Height,
                            None,
                        );
                        (res, guard.refinements_remaining > 0)
                    }
                    Err(_) => (Ok(()), false),
                };
                if result.is_err() {
                    halt_fp.store(true, Ordering::Relaxed);
                    unsafe {
                        let _ = PostThreadMessageW(
                            thread_id,
                            WM_QUIT,
                            WPARAM::default(),
                            LPARAM::default(),
                        );
                    }
                } else if arm_refine {
                    unsafe {
                        let _ = PostThreadMessageW(
                            thread_id,
                            WM_APP_ARM_REFINE,
                            WPARAM::default(),
                            LPARAM::default(),
                        );
                    }
                }
                Ok(())
            })) {
                Ok(token) => token,
                Err(err) => {
                    let _ = item.RemoveClosed(closed_token);
                    let _ = session.Close();
                    let _ = frame_pool.Close();
                    let _ = ready.try_send(Err(err.to_string()));
                    return;
                }
            };

        if let Err(err) = session.StartCapture() {
            let _ = frame_pool.RemoveFrameArrived(frame_token);
            let _ = item.RemoveClosed(closed_token);
            let _ = session.Close();
            let _ = frame_pool.Close();
            let _ = ready.try_send(Err(err.to_string()));
            return;
        }

        let _ = ready.try_send(Ok(thread_id));

        let mut refine_timer_id: usize = 0;
        let mut refine_timer_active = false;
        let mut msg = MSG::default();
        loop {
            match unsafe { GetMessageW(&mut msg, None, 0, 0).0 } {
                -1 | 0 => break,
                _ => {
                    if msg.message == WM_APP_UPDATE_CURSOR && cursor_supported {
                        let desired = desired_thread.load(Ordering::Acquire);
                        apply_wgc_cursor_visibility(
                            &session,
                            &metrics,
                            &applied_cursor,
                            desired,
                            &session_id,
                        );
                    } else if msg.message == WM_APP_REQUEST_KEYFRAME {
                        if let Ok(mut guard) = handler.lock() {
                            guard.encode_requested_keyframe(&d3d_device);
                        }
                    } else if msg.message == WM_APP_ARM_REFINE {
                        if refine_timer_active {
                            let _ = unsafe { KillTimer(None, refine_timer_id) };
                        }
                        refine_timer_id = unsafe { SetTimer(None, 1, 40, None) };
                        refine_timer_active = refine_timer_id != 0;
                    } else if msg.message == WM_TIMER
                        && refine_timer_active
                        && msg.wParam.0 == refine_timer_id
                    {
                        let keep = handler
                            .lock()
                            .ok()
                            .is_some_and(|mut guard| guard.refine_idle(&d3d_device));
                        if !keep {
                            let _ = unsafe { KillTimer(None, refine_timer_id) };
                            refine_timer_active = false;
                            refine_timer_id = 0;
                        }
                    } else {
                        unsafe {
                            let _ = TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        }
                    }
                }
            }
        }
        if refine_timer_active {
            let _ = unsafe { KillTimer(None, refine_timer_id) };
        }

        if let Ok(action) = controller.ShutdownQueueAsync() {
            if action
                .SetCompleted(&windows_future::AsyncActionCompletedHandler::new(
                    move |_, _| {
                        unsafe { PostQuitMessage(0) };
                        Ok(())
                    },
                ))
                .is_ok()
            {
                loop {
                    match unsafe { GetMessageW(&mut msg, None, 0, 0).0 } {
                        -1 | 0 => break,
                        _ => unsafe {
                            let _ = TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        },
                    }
                }
            }
        }

        let _ = frame_pool.RemoveFrameArrived(frame_token);
        let _ = frame_pool.Close();
        let _ = session.Close();
        let _ = item.RemoveClosed(closed_token);
        drop(handler);
    });

    match started.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(thread_id)) => Ok(WgcControl {
            halt,
            desired_cursor,
            thread_id,
            thread: Some(thread),
        }),
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(error)
        }
        Err(_) => {
            halt.store(true, Ordering::Release);
            Err("WGC startup timed out".into())
        }
    }
}

#[cfg(windows)]
fn capture_visual_settings(
    capture_mouse: bool,
    cursor_supported: bool,
    border_supported: bool,
) -> (CursorCaptureSettings, DrawBorderSettings) {
    // WGC itself works on Windows 10, but changing its border requires build 20348.
    // Unsupported optional settings must retain OS defaults instead of losing the
    // GPU capture/scaling path (including generic JPEG capture on AMD and Intel).
    let cursor = if !cursor_supported {
        CursorCaptureSettings::Default
    } else if capture_mouse {
        CursorCaptureSettings::WithCursor
    } else {
        CursorCaptureSettings::WithoutCursor
    };
    let border = if border_supported {
        DrawBorderSettings::WithoutBorder
    } else {
        DrawBorderSettings::Default
    };
    (cursor, border)
}

#[cfg(windows)]
fn capture_window_state(source: &str) -> Option<bool> {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{IsIconic, IsWindow},
    };
    let raw = source.strip_prefix("window:")?.parse::<usize>().ok()?;
    let hwnd = HWND(raw as *mut std::ffi::c_void);
    unsafe { IsWindow(hwnd).as_bool().then(|| IsIconic(hwnd).as_bool()) }
}

#[cfg(windows)]
fn start_capture_supervisor(source: String, capture_mouse: bool, mut flags: CaptureFlags) {
    std::thread::spawn(move || {
        use crate::capture_recovery::{input_desktop_available, CaptureRecovery, RecoveryAction};
        let mut recovery = CaptureRecovery::default();
        let mut paused = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(120));
            if !flags.active_flag.load(Ordering::Acquire) {
                break;
            }
            let desktop_available = input_desktop_available();
            if !desktop_available {
                // Retire this producer, preserving the session, delivery pacer and transports.
                flags.lifecycle.active.store(false, Ordering::Release);
                if !paused {
                    crate::logger::log_msg(
                        "INFO",
                        "capture.recovery",
                        &format!("session={} paused for desktop switch", flags.session_id),
                    );
                    paused = true;
                }
            }
            let source_exists = if !desktop_available {
                false
            } else if let Some(raw) = source.strip_prefix("window:") {
                raw.parse::<usize>().ok().map_or(false, |hwnd| unsafe {
                    windows::Win32::UI::WindowsAndMessaging::IsWindow(
                        windows::Win32::Foundation::HWND(hwnd as _),
                    )
                    .as_bool()
                })
            } else {
                source
                    .strip_prefix("screen:")
                    .and_then(|raw| raw.parse::<usize>().ok())
                    .map_or(false, |index| WgcMonitor::from_index(index + 1).is_ok())
            };
            let finished = {
                let Ok(sessions) = SESSIONS.lock() else {
                    break;
                };
                let Some(session) = sessions.get(&flags.session_id) else {
                    break;
                };
                if !Arc::ptr_eq(&session.active, &flags.active_flag) {
                    break;
                }
                session
                    .control
                    .as_ref()
                    .map_or(true, |control| control.is_finished())
                    || flags.lifecycle.closed.load(Ordering::Acquire)
            };
            let now = flags.start_instant.elapsed().as_millis() as u64;
            let minimized = desktop_available && capture_window_state(&source) == Some(true);
            match recovery.observe(
                flags.active_flag.load(Ordering::Acquire),
                desktop_available,
                source_exists,
                minimized,
                finished,
                now,
            ) {
                RecoveryAction::Continue | RecoveryAction::Wait => continue,
                RecoveryAction::Stop => break,
                RecoveryAction::SourceGone | RecoveryAction::Failed => {
                    let reason = if source_exists {
                        "capture_error"
                    } else if source.starts_with("window:") {
                        "window_closed"
                    } else {
                        "monitor_not_found"
                    };
                    signal_capture_end(&flags.session_id, &flags.active_flag, reason);
                    break;
                }
                RecoveryAction::Restart => {}
            }
            flags.lifecycle.active.store(false, Ordering::Release);
            let previous = {
                let Ok(mut sessions) = SESSIONS.lock() else {
                    break;
                };
                let Some(session) = sessions.get_mut(&flags.session_id) else {
                    break;
                };
                if !Arc::ptr_eq(&session.active, &flags.active_flag) {
                    break;
                };
                session.control.take()
            };
            // Allow the retired handler to release its GPU/encoder before rebuilding.
            // Cleanup is bounded and runs off the UI thread.
            if let Some(control) = previous {
                let _ = safely_stop_capture_control(control).join();
            }
            if !flags.active_flag.load(Ordering::Acquire) {
                break;
            }
            flags.lifecycle = Arc::new(CaptureLifecycle::new());
            flags.nvenc_keyframe.store(true, Ordering::Release);
            match start_gpu_capture(&source, capture_mouse, flags.clone()) {
                Ok((control, lifecycle)) => {
                    flags.lifecycle = lifecycle;
                    let mut control = Some(control);
                    if let Ok(mut sessions) = SESSIONS.lock() {
                        if let Some(session) = sessions.get_mut(&flags.session_id) {
                            if Arc::ptr_eq(&session.active, &flags.active_flag)
                                && session.active.load(Ordering::Acquire)
                            {
                                session.control = control.take();
                                if session.metrics.cursor_requested.load(Ordering::Acquire) {
                                    if let Some(ActiveCaptureControl::Wgc(control)) =
                                        session.control.as_ref()
                                    {
                                        let desired_embedded =
                                            !crate::remote_control::should_suppress_captured_cursor(
                                            );
                                        if session.metrics.cursor_embedded.load(Ordering::Acquire)
                                            != desired_embedded
                                        {
                                            control.set_cursor_visible(desired_embedded);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if let Some(control) = control {
                        flags.lifecycle.active.store(false, Ordering::Release);
                        safely_stop_capture_control(control);
                        break;
                    }
                    recovery.restarted(true, now);
                    paused = false;
                    crate::logger::log_msg(
                        "INFO",
                        "capture.recovery",
                        &format!("session={} GPU capture resumed", flags.session_id),
                    );
                }
                Err(error) => {
                    recovery.restarted(false, now);
                    crate::logger::log_msg(
                        "WARN",
                        "capture.recovery",
                        &format!("session={} restart failed error={error}", flags.session_id),
                    );
                }
            }
        }
    });
}

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
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(r) => r,
            Err(e) => {
                crate::logger::log_msg(
                    "ERROR",
                    "capture.websocket",
                    &format!("Tokio runtime creation failed: {e:?}"),
                );
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
                        crate::logger::log_msg("ERROR", "capture.websocket", &format!("Loopback port binding failed: {e:?}"));
                        return;
                    }
                },
            };

            if let Ok(local_addr) = listener.local_addr() {
                let port = local_addr.port();
                WS_PORT.store(port, Ordering::SeqCst);
                crate::logger::log_msg("INFO", "capture.websocket", &format!("Loopback bridge listening port={port}"));
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
                        let mut rx = sender.unwrap().subscribe();
                        if write.send(Message::Text("auth-ok".into())).await.is_err() {
                            return;
                        }
                        // Closure can precede authentication when starting without frames.
                        let terminal = SESSIONS.lock().ok().and_then(|sessions|
                            sessions.get(session_id).and_then(|session| session.terminal_signal.clone()));
                        if let Some(message) = terminal {
                            if write.send(message).await.is_err() { return; }
                        }
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

fn window_source_dimensions(win: &Window, minimized: bool) -> (u32, u32) {
    #[cfg(windows)]
    if minimized {
        use windows::Win32::{
            Foundation::HWND,
            UI::WindowsAndMessaging::{GetWindowPlacement, WINDOWPLACEMENT},
        };
        if let Ok(id) = win.id() {
            let mut placement = WINDOWPLACEMENT {
                length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                ..Default::default()
            };
            // Minimized frame bounds describe the taskbar icon, not the app's restored size.
            if unsafe {
                GetWindowPlacement(HWND(id as usize as *mut std::ffi::c_void), &mut placement)
            }
            .is_ok()
            {
                let rect = placement.rcNormalPosition;
                return (
                    (rect.right - rect.left).max(0) as u32,
                    (rect.bottom - rect.top).max(0) as u32,
                );
            }
        }
    }
    (win.width().unwrap_or(0), win.height().unwrap_or(0))
}

fn include_window_source(minimized: bool, width: u32, height: u32) -> bool {
    minimized || (width >= 250 && height >= 200)
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

            let title = win.title().unwrap_or_default();
            let title_trim = title.trim().to_string();
            let app_name = win.app_name().unwrap_or_else(|_| "Aplicativo".to_string());

            if title_trim.is_empty()
                || ignore_apps
                    .iter()
                    .any(|&ig| app_name.contains(ig) || title_trim.contains(ig))
            {
                continue;
            }

            let (width, height) = window_source_dimensions(&win, is_minimized);

            if !include_window_source(is_minimized, width, height) {
                continue;
            }

            candidate_windows.push((win, title_trim, app_name, width, height, is_minimized));
        }

        for (idx, (win, title_trim, app_name, width, height, is_minimized)) in
            candidate_windows.into_iter().enumerate()
        {
            let pid = win.pid().unwrap_or(0);
            let win_id = win
                .id()
                .map(|id| id.to_string())
                .unwrap_or_else(|_| pid.to_string());

            let mut thumb_b64 = None;
            // Only generate thumbnails for top 6 foreground windows to eliminate 2-5s IPC freeze
            if idx < 6 && !is_minimized {
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
    use std::ptr::null_mut;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBRUSH, HDC, HGDIOBJ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, ICONINFO,
    };

    unsafe {
        let mut ci = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if GetCursorInfo(&mut ci).is_err()
            || (ci.flags.0 & CURSOR_SHOWING.0 == 0)
            || ci.hCursor.is_invalid()
        {
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

                let pixel_slice = std::slice::from_raw_parts(
                    bits as *const u8,
                    (cursor_w * cursor_h * 4) as usize,
                );
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
                            let out_r =
                                (r as f32 * alpha + existing[0] as f32 * (1.0 - alpha)) as u8;
                            let out_g =
                                (g as f32 * alpha + existing[1] as f32 * (1.0 - alpha)) as u8;
                            let out_b =
                                (b as f32 * alpha + existing[2] as f32 * (1.0 - alpha)) as u8;
                            img.put_pixel(
                                target_x as u32,
                                target_y as u32,
                                image::Rgba([out_r, out_g, out_b, 255]),
                            );
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
    start_capture_session(
        "default".into(),
        source_id,
        target_fps,
        target_width,
        target_height,
        capture_mouse,
        quality,
        None,
        None,
    )
}

#[tauri::command]
pub fn start_capture_session(
    session_id: String,
    source_id: String,
    target_fps: Option<u32>,
    target_width: Option<u32>,
    target_height: Option<u32>,
    capture_mouse: Option<bool>,
    quality: Option<u8>,
    feedback_token: Option<String>,
    encoder_preference: Option<String>,
) -> Result<bool, String> {
    if session_id.is_empty() || session_id.len() > 100 {
        return Err("Invalid capture session".into());
    }
    if source_id.trim().is_empty() {
        return Err("sourceId cannot be empty".to_string());
    }
    ensure_ws_server_running();

    // Stop any existing capture session first
    let _ = stop_capture_session(session_id.clone());

    if session_id == "default" {
        crate::stream_pointer::set_source(Some(source_id.clone()));
    }
    CAPTURING_VIDEO.store(true, Ordering::SeqCst);
    let is_capturing = Arc::new(AtomicBool::new(true));
    let is_capturing_clone = is_capturing.clone();

    let fps = target_fps.unwrap_or(60).clamp(15, 120);
    let width = target_width.unwrap_or(0);
    let height = target_height.unwrap_or(0);
    let should_draw_mouse = capture_mouse.unwrap_or(true);
    let jpeg_quality = quality.unwrap_or(90).clamp(50, 98);

    let sender = if session_id == "default" {
        get_frame_sender().clone()
    } else {
        broadcast::channel(32).0
    };
    let metrics = Arc::new(CaptureMetrics::default());
    metrics
        .cursor_requested
        .store(should_draw_mouse, Ordering::Release);
    metrics
        .cursor_embedded
        .store(should_draw_mouse, Ordering::Release);
    let load = Arc::new(crate::video_load::CaptureLoad::new(
        fps,
        width,
        height,
        feedback_token,
    ));
    let try_nvenc = nvenc_requested(
        encoder_preference.as_deref(),
        std::env::var("P2SHARER_NATIVE_NVENC").ok().as_deref(),
    );
    let try_mf = mf_requested(std::env::var("P2SHARER_NATIVE_MF").ok().as_deref());
    let nvenc_enabled = Arc::new(AtomicBool::new(try_nvenc || try_mf));
    crate::logger::log_msg("INFO", "capture.start", &format!("session={session_id} source={source_id} requested={width}x{height}@{fps} cursor={should_draw_mouse} jpeg_quality={jpeg_quality} preference={} nvenc_requested={try_nvenc} mf_requested={try_mf}",
        encoder_preference.as_deref().unwrap_or("auto")));
    let nvenc_keyframe = Arc::new(AtomicBool::new(true));
    let wgc_thread_id = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let nvenc_bitrate = Arc::new(std::sync::atomic::AtomicU32::new(15_000_000));
    let consumers_active = Arc::new(AtomicBool::new(true));
    let native_route_count = Arc::new(AtomicUsize::new(0));
    SESSIONS
        .lock()
        .map_err(|_| "Capture session lock poisoned")?
        .insert(
            session_id.clone(),
            CaptureSession {
                nvenc_enabled: nvenc_enabled.clone(),
                nvenc_keyframe: nvenc_keyframe.clone(),
                wgc_thread_id: wgc_thread_id.clone(),
                nvenc_bitrate: nvenc_bitrate.clone(),
                consumers_active: consumers_active.clone(),
                native_route_count: native_route_count.clone(),
                source: source_id.clone(),
                active: is_capturing.clone(),
                sender: sender.clone(),
                terminal_signal: None,
                metrics: metrics.clone(),
                load: load.clone(),
                #[cfg(windows)]
                control: None,
            },
        );
    let start_instant = std::time::Instant::now();
    let legacy_pacing = std::env::var("P2SHARER_LEGACY_VIDEO_PACING").as_deref() == Ok("1");
    let delivery: FrameDelivery = Arc::new((
        std::sync::Mutex::new(FramePacer::new(fps)),
        std::sync::Condvar::new(),
    ));
    start_frame_delivery(
        delivery.clone(),
        is_capturing.clone(),
        load.clone(),
        sender.clone(),
        metrics.clone(),
        start_instant,
        consumers_active.clone(),
        native_route_count.clone(),
    );

    #[cfg(windows)]
    {
        let mut flags = CaptureFlags {
            lifecycle: Arc::new(CaptureLifecycle::new()),
            prefer_dxgi: Arc::new(AtomicBool::new(match std::env::var("P2SHARER_CAPTURE_BACKEND").as_deref() {
                Ok("wgc") => false, Ok("dxgi") => true,
                _ => !windows_capture::graphics_capture_api::GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false),
            })),
            nvenc_sequence: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            try_nvenc, try_mf,
            session_id: session_id.clone(),
            nvenc_enabled: nvenc_enabled.clone(), nvenc_keyframe: nvenc_keyframe.clone(), nvenc_bitrate: nvenc_bitrate.clone(),
            consumers_active: consumers_active.clone(),
            native_route_count: native_route_count.clone(),
            delivery: delivery.clone(),
            legacy_pacing,
            metrics: metrics.clone(),
            load: load.clone(),
            sender: sender.clone(),
            target_fps: fps,
            target_width: width,
            target_height: height,
            quality: jpeg_quality,
            active_flag: is_capturing.clone(),
            start_instant,
        };

        match start_gpu_capture(&source_id, should_draw_mouse, flags.clone()) {
            Ok((control, lifecycle)) => {
                flags.lifecycle = lifecycle;
                let mut control = Some(control);
                if let Ok(mut sessions) = SESSIONS.lock() {
                    if let Some(session) = sessions.get_mut(&session_id) {
                        if Arc::ptr_eq(&session.active, &flags.active_flag)
                            && session.active.load(Ordering::Acquire)
                        {
                            if let Some(ActiveCaptureControl::Wgc(ref wgc)) = control {
                                session
                                    .wgc_thread_id
                                    .store(wgc.thread_id, Ordering::Release);
                            }
                            session.control = control.take();
                        }
                    }
                }
                if let Some(control) = control {
                    flags.lifecycle.active.store(false, Ordering::Release);
                    safely_stop_capture_control(control);
                    return Ok(false);
                }
                start_capture_supervisor(source_id.clone(), should_draw_mouse, flags);
                crate::logger::log_msg(
                    "INFO",
                    "capture.start",
                    &format!(
                        "session={session_id} backend=GPU startup_ms={} awaiting_first_frame=true",
                        start_instant.elapsed().as_millis()
                    ),
                );
                return Ok(true);
            }
            Err(error) if capture_window_state(&source_id) == Some(true) => {
                crate::logger::log_msg(
                    "INFO",
                    "capture.start",
                    &format!("session={session_id} WGC waiting for minimized window error={error}"),
                );
                start_capture_supervisor(source_id.clone(), should_draw_mouse, flags);
                return Ok(true);
            }
            Err(error) => crate::logger::log_msg(
                "WARN",
                "capture.start",
                &format!("session={session_id} WGC start failed; fallback=xcap error={error}"),
            ),
        }
    }

    // Fallback capture thread (xcap) if WGC is unsupported or failed
    metrics.capture_backend.store(3, Ordering::Relaxed);
    crate::logger::log_msg("WARN", "capture.start", &format!("session={session_id} backend=xcap encoder=libjpeg-turbo/JPEG reason=WGC_unavailable_or_start_failed"));
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
                wins.into_iter()
                    .find(|w| w.id().map(|id| id.to_string()).unwrap_or_default() == target_win_id)
            })
        } else {
            None
        };

        let mut last_retry = std::time::Instant::now();
        let mut consecutive_errors: u32 = 0;
        #[cfg(windows)]
        let mut desktop_paused = false;
        #[cfg(windows)]
        let mut recovery_grace = std::time::Instant::now();
        let mut jpeg_encoder = match RealtimeJpegEncoder::new(jpeg_quality) {
            Ok(encoder) => encoder,
            Err(error) => {
                crate::logger::log_msg(
                    "ERROR",
                    "capture.jpeg",
                    &format!("session={session_id} initialization failed error={error:?}"),
                );
                let _ = sender.send(Message::Text(
                    "{\"type\":\"fallback\",\"reason\":\"capture_error\"}".into(),
                ));
                is_capturing_clone.store(false, Ordering::Relaxed);
                return;
            }
        };
        let mut resizer = fast_image_resize::Resizer::new();
        let mut resized_img_buf: Option<fast_image_resize::images::Image<'static>> = None;

        while is_capturing_clone.load(Ordering::Relaxed) {
            if !consumers_active.load(Ordering::Relaxed)
                && native_route_count.load(Ordering::Relaxed) == 0
                && metrics.images.load(Ordering::Relaxed) > 0
            {
                std::thread::sleep(std::time::Duration::from_millis(200));
                continue;
            }
            let loop_start = std::time::Instant::now();
            let frame_interval =
                std::time::Duration::from_nanos(1_000_000_000 / u64::from(load.fps()));

            #[cfg(windows)]
            {
                if !crate::capture_recovery::input_desktop_available() {
                    if !desktop_paused {
                        crate::logger::log_msg(
                            "INFO",
                            "capture.recovery",
                            &format!("session={session_id} xcap paused for desktop switch"),
                        );
                    }
                    desktop_paused = true;
                    consecutive_errors = 0;
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    continue;
                }
                if desktop_paused {
                    cached_monitor = None;
                    cached_window = None;
                    last_retry = std::time::Instant::now() - std::time::Duration::from_millis(501);
                    recovery_grace = std::time::Instant::now() + std::time::Duration::from_secs(3);
                    desktop_paused = false;
                    crate::logger::log_msg(
                        "INFO",
                        "capture.recovery",
                        &format!("session={session_id} xcap desktop returned; reacquiring source"),
                    );
                }
                if std::time::Instant::now() < recovery_grace {
                    consecutive_errors = 0;
                }
            }

            let captured_img = if is_window {
                #[cfg(windows)]
                match capture_window_state(&source_id) {
                    None => {
                        signal_capture_end(&session_id, &is_capturing_clone, "window_closed");
                        break;
                    }
                    Some(true) => {
                        consecutive_errors = 0;
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        continue;
                    }
                    Some(false) => {}
                }
                if let Some(ref win) = cached_window {
                    if win.is_minimized().unwrap_or(false) {
                        consecutive_errors = 0;
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        continue;
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
                            {
                                let draw_cursor = should_draw_mouse
                                    && !crate::remote_control::should_suppress_captured_cursor();
                                metrics
                                    .cursor_embedded
                                    .store(draw_cursor, Ordering::Release);
                                if draw_cursor {
                                    draw_authentic_cursor(&mut img, origin_x, origin_y);
                                }
                            }
                            Some(img)
                        }
                        Err(error) => {
                            cached_window = None;
                            consecutive_errors += 1;
                            crate::logger::log_msg("WARN", "capture.source", &format!("session={session_id} source={source_id} backend=xcap attempt={consecutive_errors}/5 error={error:?}"));
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
                        crate::logger::log_msg("ERROR", "capture.source", &format!("session={session_id} source={source_id} backend=xcap reason=window_not_found"));
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
                            {
                                let draw_cursor = should_draw_mouse
                                    && !crate::remote_control::should_suppress_captured_cursor();
                                metrics
                                    .cursor_embedded
                                    .store(draw_cursor, Ordering::Release);
                                if draw_cursor {
                                    draw_authentic_cursor(&mut img, origin_x, origin_y);
                                }
                            }
                            Some(img)
                        }
                        Err(error) => {
                            cached_monitor = None;
                            consecutive_errors += 1;
                            crate::logger::log_msg("WARN", "capture.source", &format!("session={session_id} source={source_id} backend=xcap attempt={consecutive_errors}/5 error={error:?}"));
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
                        crate::logger::log_msg("ERROR", "capture.source", &format!("session={session_id} source={source_id} backend=xcap reason=monitor_not_found"));
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

                match jpeg_encoder.encode_rgba(final_raw, final_w, final_h) {
                    Ok(jpeg_bytes) => {
                        log_selected_encoder(
                            &metrics,
                            &session_id,
                            2,
                            final_w,
                            final_h,
                            load.fps(),
                            start_instant.elapsed().as_millis(),
                        );
                        load.output(final_w, final_h);
                        metrics.images.fetch_add(1, Ordering::Relaxed);
                        let frame_arc = Arc::new(jpeg_bytes);
                        enqueue_capture_frame(
                            &delivery,
                            frame_arc,
                            start_instant.elapsed().as_micros() as u64,
                            legacy_pacing,
                            &is_capturing_clone,
                            &sender,
                            &metrics,
                        );
                        let processing_us = loop_start.elapsed().as_micros() as u64;
                        metrics
                            .processing_us
                            .fetch_add(processing_us, Ordering::Relaxed);
                        load_controller.observe(&load, load.elapsed_ms(), processing_us);
                    }
                    Err(error) => {
                        let failures = metrics.jpeg_errors.fetch_add(1, Ordering::Relaxed) + 1;
                        if failures.is_power_of_two() {
                            crate::logger::log_msg("ERROR", "capture.jpeg", &format!("session={session_id} backend=xcap failures={failures} output={final_w}x{final_h} error={error:?}"));
                        }
                    }
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
fn safely_stop_capture_control(control: ActiveCaptureControl) -> std::thread::JoinHandle<()> {
    use std::os::windows::prelude::AsRawHandle;
    use windows::Win32::Foundation::{HANDLE, LPARAM, WPARAM};
    use windows::Win32::System::Threading::GetThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};

    let mut control = match control {
        ActiveCaptureControl::Wgc(control) => control,
        ActiveCaptureControl::Dxgi { halt, thread } => {
            halt.store(true, Ordering::Release);
            return std::thread::spawn(move || {
                finish_capture_thread(thread);
            });
        }
    };
    // 1. Signal halt flag immediately so FrameArrived stops processing frames.
    control.halt.store(true, Ordering::SeqCst);

    // 2. Extract thread handle and its raw Win32 thread ID.
    let Some(thread_handle) = control.thread.take() else {
        return std::thread::spawn(|| {});
    };
    let thread_id = if control.thread_id != 0 {
        control.thread_id
    } else {
        unsafe { GetThreadId(HANDLE(thread_handle.as_raw_handle())) }
    };

    // 3. Spawn a graceful shutdown task that NEVER busy-loops with yield_now()
    std::thread::spawn(move || {
        if thread_id != 0 {
            let _ = unsafe { PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
            std::thread::sleep(std::time::Duration::from_millis(30));
            if !thread_handle.is_finished() {
                let _ = unsafe { PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
            }
        }

        finish_capture_thread(thread_handle);
    })
}

#[cfg(windows)]
fn finish_capture_thread<T>(thread: std::thread::JoinHandle<T>) {
    let started = std::time::Instant::now();
    while !thread.is_finished() && started.elapsed().as_millis() < 600 {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    if thread.is_finished() {
        let _ = thread.join();
    }
}

#[tauri::command]
pub fn stop_native_screen_capture() -> Result<bool, String> {
    let ids: Vec<String> = SESSIONS
        .lock()
        .map_err(|_| "Capture session lock poisoned")?
        .keys()
        .cloned()
        .collect();
    for id in ids {
        stop_capture_session(id)?;
    }
    Ok(true)
}

#[tauri::command]
pub fn stop_capture_session(session_id: String) -> Result<bool, String> {
    let session = SESSIONS
        .lock()
        .map_err(|_| "Capture session lock poisoned")?
        .remove(&session_id);
    if let Some(session) = session {
        crate::logger::log_msg("INFO", "capture.stop", &format!("session={session_id} source={} images={} nvenc_images={} nvenc_fallbacks={} readback_errors={} jpeg_errors={}", session.source,
            session.metrics.images.load(Ordering::Relaxed), session.metrics.nvenc_images.load(Ordering::Relaxed),
            session.metrics.nvenc_fallbacks.load(Ordering::Relaxed), session.metrics.readback_errors.load(Ordering::Relaxed), session.metrics.jpeg_errors.load(Ordering::Relaxed)));
        session.active.store(false, Ordering::SeqCst);
        session.wgc_thread_id.store(0, Ordering::Release);
        #[cfg(windows)]
        if let Some(control) = session.control {
            safely_stop_capture_control(control);
        }
    }
    let empty = SESSIONS
        .lock()
        .map_err(|_| "Capture session lock poisoned")?
        .is_empty();
    CAPTURING_VIDEO.store(!empty, Ordering::SeqCst);
    if empty {
        crate::stream_pointer::set_source(None);
    }
    Ok(true)
}

#[tauri::command]
pub fn select_pointer_capture(session_id: Option<String>) -> Result<(), String> {
    let source = match session_id {
        Some(id) => Some(
            SESSIONS
                .lock()
                .map_err(|_| "Capture session lock poisoned")?
                .get(&id)
                .ok_or("Capture session is no longer active")?
                .source
                .clone(),
        ),
        None => None,
    };
    crate::stream_pointer::set_source(source);
    Ok(())
}

pub fn pointer_capture_source(session_id: &str) -> Option<String> {
    SESSIONS
        .lock()
        .ok()?
        .get(session_id)
        .map(|session| session.source.clone())
}

pub fn active_cursor_session_info(
    preferred_session_id: Option<&str>,
) -> Option<(String, String, bool)> {
    let sessions = SESSIONS.lock().ok()?;
    let pick = preferred_session_id
        .and_then(|sid| sessions.get(sid).map(|s| (sid, s)))
        .filter(|(_, s)| s.active.load(Ordering::Acquire))
        .or_else(|| {
            sessions
                .iter()
                .find(|(_, s)| {
                    s.active.load(Ordering::Acquire)
                        && (s.source.starts_with("screen:") || s.source.starts_with("window:"))
                })
                .map(|(k, s)| (k.as_str(), s))
        })?;
    let (sid, session) = pick;
    let requested = session.metrics.cursor_requested.load(Ordering::Acquire);
    let backend = session.metrics.capture_backend.load(Ordering::Relaxed);
    let embedded = if backend == 2 {
        requested && !crate::remote_control::should_suppress_captured_cursor()
    } else {
        session.metrics.cursor_embedded.load(Ordering::Acquire)
    };
    Some((sid.to_string(), session.source.clone(), embedded))
}

pub fn refresh_wgc_cursor_for_remote_control() {
    #[cfg(windows)]
    {
        use windows_capture::graphics_capture_api::GraphicsCaptureApi;
        if !GraphicsCaptureApi::is_cursor_settings_supported().unwrap_or(false) {
            return;
        }
        let suppress = crate::remote_control::should_suppress_captured_cursor();
        let desired_embedded = !suppress;
        if let Ok(sessions) = SESSIONS.lock() {
            for session in sessions.values() {
                if !session.active.load(Ordering::Acquire)
                    || !session.metrics.cursor_requested.load(Ordering::Acquire)
                {
                    continue;
                }
                if let Some(ActiveCaptureControl::Wgc(control)) = session.control.as_ref() {
                    if session.metrics.cursor_embedded.load(Ordering::Acquire) != desired_embedded {
                        control.set_cursor_visible(desired_embedded);
                    }
                }
            }
        }
    }
}

/// Bound capture dimensions without changing the monitor/window aspect ratio or upscaling.
pub(crate) fn fit_capture_dimensions(
    width: u32,
    height: u32,
    max_width: u32,
    max_height: u32,
) -> (u32, u32) {
    if width == 0 || height == 0 || max_width == 0 || max_height == 0 {
        return (width, height);
    }
    let scale = (max_width as f64 / width as f64)
        .min(max_height as f64 / height as f64)
        .min(1.0);
    (
        (width as f64 * scale).round().max(1.0) as u32,
        (height as f64 * scale).round().max(1.0) as u32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_wgc_settings_preserve_capture_on_older_windows() {
        for capture_mouse in [false, true] {
            for cursor_supported in [false, true] {
                for border_supported in [false, true] {
                    let (cursor, border) =
                        capture_visual_settings(capture_mouse, cursor_supported, border_supported);
                    assert_eq!(
                        border,
                        if border_supported {
                            DrawBorderSettings::WithoutBorder
                        } else {
                            DrawBorderSettings::Default
                        }
                    );
                    assert_eq!(
                        cursor,
                        if !cursor_supported {
                            CursorCaptureSettings::Default
                        } else if capture_mouse {
                            CursorCaptureSettings::WithCursor
                        } else {
                            CursorCaptureSettings::WithoutCursor
                        }
                    );
                }
            }
        }
    }

    #[test]
    #[ignore = "requires an interactive Windows desktop and capture permission; captures pixels in memory only"]
    fn live_generic_wgc_retains_requested_profile_without_nvenc() {
        assert_eq!(
            std::env::var("P2SHARER_NATIVE_MF").as_deref(),
            Ok("0"),
            "set P2SHARER_NATIVE_MF=0 to exercise the JPEG fallback explicitly"
        );
        assert_eq!(
            std::env::var("P2SHARER_CAPTURE_BACKEND").as_deref(),
            Ok("wgc"),
            "set P2SHARER_CAPTURE_BACKEND=wgc to exercise WGC explicitly"
        );
        let monitor = list_screen_sources()
            .monitors
            .into_iter()
            .find(|monitor| monitor.is_primary)
            .expect("live capture requires a primary monitor");
        let expected = fit_capture_dimensions(monitor.width, monitor.height, 1920, 1080);
        let session_id = "generic-wgc-compatibility-test";
        start_capture_session(
            session_id.into(),
            monitor.id,
            Some(60),
            Some(1920),
            Some(1080),
            Some(true),
            Some(90),
            None,
            Some("generic".into()),
        )
        .unwrap();
        // Always release capture resources, including when an assertion fails.
        struct Cleanup;
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = stop_capture_session("generic-wgc-compatibility-test".into());
            }
        }
        let _cleanup = Cleanup;
        let (metrics, load, mut receiver) = {
            let sessions = SESSIONS.lock().unwrap();
            let session = sessions.get(session_id).unwrap();
            assert!(
                session.control.is_some(),
                "generic capture must retain GPU capture"
            );
            assert!(!session.nvenc_enabled.load(Ordering::Relaxed));
            (
                session.metrics.clone(),
                session.load.clone(),
                session.sender.subscribe(),
            )
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
        let mut decoded = 0;
        while std::time::Instant::now() < deadline {
            if let Ok(Message::Binary(bytes)) = receiver.try_recv() {
                if bytes.len() > 4 {
                    let image = image::load_from_memory(&bytes)
                        .expect("generic output must be decodable JPEG");
                    assert_eq!((image.width(), image.height()), expected);
                    decoded += 1;
                }
            } else {
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        }
        let images = metrics.images.load(Ordering::Relaxed);
        assert_eq!(
            metrics.capture_backend.load(Ordering::Relaxed),
            1,
            "WGC must be the actual capture backend"
        );
        assert!(
            decoded > 0 && images > 0,
            "WGC must deliver real images, not only repeat ticks"
        );
        assert_eq!(metrics.nvenc_images.load(Ordering::Relaxed), 0);
        assert_eq!(load.snapshot().resolution_scale_percent, 100);
        assert_eq!(load.fps(), 60);
        eprintln!("generic WGC: images={images} decoded={decoded} mean_processing_us={} readback_errors={} profile={}x{}@{}",
            metrics.processing_us.load(Ordering::Relaxed) / images,
            metrics.readback_errors.load(Ordering::Relaxed), expected.0, expected.1, load.fps());
    }

    #[test]
    #[ignore = "requires an interactive Windows desktop, DXGI monitor capture and a hardware H264 encoder"]
    fn live_dxgi_recreates_producer_with_preserved_session_and_recovery_key() {
        let monitor = list_screen_sources()
            .monitors
            .into_iter()
            .find(|monitor| monitor.is_primary)
            .expect("live capture requires a primary monitor");
        let id = "dxgi-producer-recovery-test";
        start_capture_session(
            id.into(),
            monitor.id,
            Some(60),
            Some(1920),
            Some(1080),
            Some(true),
            Some(90),
            None,
            Some("generic".into()),
        )
        .unwrap();
        struct Cleanup;
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = stop_capture_session("dxgi-producer-recovery-test".into());
            }
        }
        let _cleanup = Cleanup;
        let (active, halt, mut receiver) = {
            let sessions = SESSIONS.lock().unwrap();
            let session = &sessions[id];
            assert_eq!(session.metrics.capture_backend.load(Ordering::Relaxed), 2);
            let Some(ActiveCaptureControl::Dxgi { halt, .. }) = &session.control else {
                panic!("DXGI required");
            };
            (
                session.active.clone(),
                halt.clone(),
                session.sender.subscribe(),
            )
        };
        fn packet(receiver: &mut broadcast::Receiver<Message>) -> Vec<u8> {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while std::time::Instant::now() < deadline {
                if let Ok(Message::Binary(bytes)) = receiver.try_recv() {
                    if bytes.starts_with(b"P2NV") {
                        return bytes;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            panic!("Native H264 frame required");
        }
        let before = packet(&mut receiver);
        halt.store(true, Ordering::Release);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            assert!(
                std::time::Instant::now() < deadline,
                "DXGI producer did not restart"
            );
            let replaced = {
                let sessions = SESSIONS.lock().unwrap();
                let session = &sessions[id];
                assert!(Arc::ptr_eq(&active, &session.active) && active.load(Ordering::Acquire));
                matches!(&session.control, Some(ActiveCaptureControl::Dxgi { halt: current, .. }) if !Arc::ptr_eq(&halt, current))
            };
            if replaced {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        // Old queued dependent frames can precede the replacement's recovery IDR.
        loop {
            assert!(std::time::Instant::now() < deadline, "Recovery key missing");
            let after = packet(&mut receiver);
            let previous = u32::from_le_bytes(before[16..20].try_into().unwrap());
            let current = u32::from_le_bytes(after[16..20].try_into().unwrap());
            if current > previous && after[5] != 0 {
                assert_eq!(&before[8..16], &after[8..16]);
                break;
            }
        }
    }

    #[test]
    fn minimized_sources_survive_icon_sized_or_unavailable_bounds() {
        assert!(include_window_source(true, 160, 28));
        assert!(include_window_source(true, 0, 0));
        assert!(include_window_source(false, 1280, 720));
        assert!(!include_window_source(false, 160, 28));
    }

    #[test]
    fn retired_capture_producer_cannot_publish_into_preserved_transport() {
        let delivery = Arc::new((
            std::sync::Mutex::new(FramePacer::new(60)),
            std::sync::Condvar::new(),
        ));
        let (sender, mut receiver) = broadcast::channel(32);
        let metrics = CaptureMetrics::default();
        let active = AtomicBool::new(false);
        for legacy in [false, true] {
            assert!(!enqueue_capture_frame(
                &delivery,
                Arc::new(vec![1, 2, 3]),
                0,
                legacy,
                &active,
                &sender,
                &metrics
            ));
        }
        assert!(delivery.0.lock().unwrap().tick(1_000_000).is_none());
        assert!(matches!(
            receiver.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        // The same delivery resources can accept the replacement producer.
        active.store(true, Ordering::Release);
        assert!(enqueue_capture_frame(
            &delivery,
            Arc::new(vec![4, 5, 6]),
            1_000_000,
            false,
            &active,
            &sender,
            &metrics
        ));
        assert!(matches!(
            delivery.0.lock().unwrap().tick(1_020_000),
            Some(PacedFrame::Fresh { .. })
        ));
    }

    #[test]
    fn encoder_selection_defaults_and_diagnostic_override_are_safe() {
        for preference in [None, Some("auto"), Some("amd"), Some("invalid")] {
            assert!(nvenc_requested(preference, None));
            assert!(!nvenc_requested(preference, Some("0")));
        }
        assert!(!nvenc_requested(Some("generic"), Some("1")));
        assert!(nvenc_requested(Some("nvenc"), Some("0")));
        assert!(mf_requested(None));
        assert!(!mf_requested(Some("0")));
    }

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
            SESSIONS.lock().unwrap().insert(
                id.into(),
                CaptureSession {
                    nvenc_enabled: Arc::new(AtomicBool::new(false)),
                    nvenc_keyframe: Arc::new(AtomicBool::new(true)),
                    wgc_thread_id: Arc::new(std::sync::atomic::AtomicU32::new(0)),
                    nvenc_bitrate: Arc::new(std::sync::atomic::AtomicU32::new(15_000_000)),
                    consumers_active: Arc::new(AtomicBool::new(true)),
                    native_route_count: Arc::new(AtomicUsize::new(0)),
                    metrics: Arc::new(CaptureMetrics::default()),
                    load: Arc::new(crate::video_load::CaptureLoad::new(60, 0, 0, None)),
                    source: "screen:0".into(),
                    active: Arc::new(AtomicBool::new(true)),
                    sender,
                    terminal_signal: None,
                    #[cfg(windows)]
                    control: None,
                },
            );
        }
        let url = format!("ws://127.0.0.1:{}", get_video_ws_port());
        let (mut first, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        let (mut second, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        first
            .send(Message::Text(format!("{}:socket-test-a", video_ws_token())))
            .await
            .unwrap();
        second
            .send(Message::Text(format!("{}:socket-test-b", video_ws_token())))
            .await
            .unwrap();
        assert_eq!(
            first.next().await.unwrap().unwrap().into_text().unwrap(),
            "auth-ok"
        );
        assert_eq!(
            second.next().await.unwrap().unwrap().into_text().unwrap(),
            "auth-ok"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        a.send(Message::Binary(vec![11, 11, 11, 11, 11])).unwrap();
        b.send(Message::Binary(vec![22, 22, 22, 22, 22])).unwrap();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(2), first.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .into_data(),
            vec![11; 5]
        );
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(2), second.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .into_data(),
            vec![22; 5]
        );
        stop_capture_session("socket-test-a".into()).unwrap();
        b.send(Message::Binary(vec![33; 5])).unwrap();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(2), second.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .into_data(),
            vec![33; 5]
        );
        let active = SESSIONS
            .lock()
            .unwrap()
            .get("socket-test-b")
            .unwrap()
            .active
            .clone();
        signal_capture_end(
            "socket-test-b",
            &Arc::new(AtomicBool::new(true)),
            "window_closed",
        );
        assert!(SESSIONS
            .lock()
            .unwrap()
            .get("socket-test-b")
            .unwrap()
            .terminal_signal
            .is_none());
        signal_capture_end("socket-test-b", &active, "window_closed");
        let (mut late, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        late.send(Message::Text(format!("{}:socket-test-b", video_ws_token())))
            .await
            .unwrap();
        assert_eq!(
            late.next().await.unwrap().unwrap().into_text().unwrap(),
            "auth-ok"
        );
        let closure = tokio::time::timeout(std::time::Duration::from_secs(2), late.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(closure.into_text().unwrap().contains("window_closed"));
        stop_capture_session("socket-test-b".into()).unwrap();
    }

    #[test]
    #[ignore = "requires an interactive Windows desktop and capture permission"]
    fn simultaneous_native_sessions_keep_frames_and_teardown_independent() {
        let monitor = list_screen_sources()
            .monitors
            .into_iter()
            .find(|monitor| monitor.is_primary)
            .expect("manual capture check requires a primary monitor");
        let first_size = fit_capture_dimensions(monitor.width, monitor.height, 640, 360);
        let second_size = fit_capture_dimensions(monitor.width, monitor.height, 320, 180);
        start_capture_session(
            "capture-test-a".into(),
            monitor.id.clone(),
            Some(30),
            Some(640),
            Some(360),
            Some(true),
            Some(75),
            None,
            Some("generic".into()),
        )
        .unwrap();
        start_capture_session(
            "capture-test-b".into(),
            monitor.id.clone(),
            Some(30),
            Some(320),
            Some(180),
            Some(true),
            Some(85),
            None,
            Some("generic".into()),
        )
        .unwrap();
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
        assert_eq!(next_image(&mut first), first_size);
        assert_eq!(next_image(&mut second), second_size);
        stop_capture_session("capture-test-a".into()).unwrap();
        assert!(second_active.load(Ordering::SeqCst));
        assert!(is_video_capturing());
        assert_eq!(next_image(&mut second), second_size);
        stop_capture_session("capture-test-b".into()).unwrap();
        assert!(!second_active.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn video_websocket_requires_process_token_before_streaming() {
        ensure_ws_server_running();
        let port = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let port = get_video_ws_port();
                if port != 0 {
                    break port;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("video WebSocket did not start");
        let url = format!("ws://127.0.0.1:{port}");

        let (mut unauthorized, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        unauthorized
            .send(Message::Text("invalid".into()))
            .await
            .unwrap();
        let rejected = tokio::time::timeout(std::time::Duration::from_secs(2), unauthorized.next())
            .await
            .expect("unauthorized client was not disconnected");
        assert!(matches!(rejected, Some(Ok(Message::Close(_)))));

        let (mut authorized, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        authorized
            .send(Message::Text(video_ws_token().into()))
            .await
            .unwrap();
        let acknowledgement =
            tokio::time::timeout(std::time::Duration::from_secs(2), authorized.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        assert_eq!(acknowledgement.into_text().unwrap(), "auth-ok");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        get_frame_sender()
            .send(Message::Binary(vec![1, 2, 3]))
            .unwrap();
        // A capture stopped by an earlier test can finish one in-flight callback.
        // Authentication must deliver the marker, not depend on its being first.
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while let Some(message) = authorized.next().await {
                if message.unwrap() == Message::Binary(vec![1, 2, 3]) {
                    return;
                }
            }
            panic!("Authenticated video socket closed before receiving the marker");
        })
        .await
        .expect("Authenticated video socket did not deliver the marker");
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
    #[ignore = "requires an interactive Windows desktop and capture permission"]
    fn live_capture_produces_images_and_stops_idempotently() {
        let monitor = list_screen_sources()
            .monitors
            .into_iter()
            .find(|monitor| monitor.is_primary)
            .expect("manual capture check requires a primary monitor");
        let mut rx = get_frame_sender().subscribe();
        let res = start_native_screen_capture(
            monitor.id,
            Some(60),
            Some(1920),
            Some(1080),
            Some(true),
            Some(80),
        );
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
        let fps = if elapsed_sec > 0.0 {
            frame_count as f64 / elapsed_sec
        } else {
            0.0
        };
        println!(
            "Captured {} messages in {:.2}s = {:.1} messages/s ({} images, {} heartbeats)",
            frame_count, elapsed_sec, fps, image_frame_count, heartbeat_count
        );

        let stop_res = stop_native_screen_capture();
        println!("stop_native_screen_capture result: {:?}", stop_res);
        assert!(stop_res.is_ok());
        assert!(stop_native_screen_capture().is_ok());
        assert!(
            image_frame_count > 0,
            "Capture produced only heartbeat messages"
        );
    }
}

#[cfg(feature = "media-diagnostics")]
fn diagnostic_tick(last: &std::sync::atomic::AtomicU64, max: &std::sync::atomic::AtomicU64) {
    let now = crate::media_diagnostics::elapsed_us();
    let previous = last.swap(now, Ordering::Relaxed);
    if previous != 0 {
        max.fetch_max(now.saturating_sub(previous), Ordering::Relaxed);
    }
}

#[cfg(feature = "media-diagnostics")]
fn diagnostic_age(last: u64) -> Option<u64> {
    (last != 0).then(|| crate::media_diagnostics::elapsed_us().saturating_sub(last))
}
