//! On-demand native performance diagnostic collector.
//!
//! Zero runtime overhead when idle: no background threads or polling run unless
//! a diagnostic session is explicitly started from Settings.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

use crate::screen_sources::ActiveCaptureDiagnosticSnapshot;

const MAX_TIMELINE_SAMPLES: usize = 120;
const MAX_TOP_THREADS: usize = 20;
const MAX_REPORT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub struct PerformanceDiagState {
    active: Mutex<Option<ActiveSession>>,
}

struct ActiveSession {
    session_id: u64,
    started_at: Instant,
    started_epoch_ms: u64,
    last_tick_at: Instant,
    hardware: HardwareInfo,
    baseline_processes: HashMap<u32, ProcessSample>,
    prev_processes: HashMap<u32, ProcessSample>,
    baseline_threads: HashMap<u32, ThreadSample>,
    baseline_captures: Vec<ActiveCaptureDiagnosticSnapshot>,
    sys: System,
    timeline: Vec<PerfDiagTickSample>,
    peak_p2sharer_cpu_pct: f64,
    peak_webview2_cpu_pct: f64,
    peak_combined_cpu_pct: f64,
    peak_system_cpu_pct: f64,
    system_cpu_sum: f64,
    system_cpu_samples: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct GpuAdapterInfo {
    pub description: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub dedicated_vram_mb: u64,
    pub shared_memory_mb: u64,
    pub is_software: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct HardwareInfo {
    pub app_version: String,
    pub build_mode: &'static str,
    pub arch: &'static str,
    pub os_name: String,
    pub os_version: String,
    pub cpu_brand: String,
    pub cpu_logical_cores: usize,
    pub cpu_physical_cores: usize,
    pub cpu_frequency_mhz: u64,
    pub total_ram_mb: u64,
    pub available_ram_mb: u64,
    pub used_ram_mb: u64,
    pub gpu_adapters: Vec<GpuAdapterInfo>,
    pub native_nvenc_available: bool,
    pub native_encoder_note: String,
}

#[derive(Clone, Debug)]
struct ProcessSample {
    exe_name: String,
    role: String,
    kernel_100ns: u64,
    user_100ns: u64,
    working_set_bytes: u64,
    private_bytes: u64,
}

#[derive(Clone, Debug)]
struct ThreadSample {
    name: String,
    kernel_100ns: u64,
    user_100ns: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct PerfDiagStartResult {
    pub session_id: u64,
    pub started_epoch_ms: u64,
    pub hardware: HardwareInfo,
}

#[derive(Clone, Debug, Serialize)]
pub struct PerfDiagTickSample {
    pub elapsed_ms: u64,
    pub delta_ms: u64,
    pub p2sharer_cpu_pct: f64,
    pub webview2_cpu_pct: f64,
    pub webview2_renderer_cpu_pct: f64,
    pub webview2_gpu_cpu_pct: f64,
    pub combined_cpu_pct: f64,
    pub system_cpu_pct: f64,
    pub p2sharer_working_set_mb: f64,
    pub webview2_working_set_mb: f64,
    pub webview2_process_count: usize,
    pub active_capture_count: usize,
    pub audio_capture_active: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProcessCpuBreakdown {
    pub pid: u32,
    pub exe_name: String,
    pub role: String,
    pub cpu_pct_total: f64,
    pub cpu_pct_single_core: f64,
    pub cpu_ms_per_sec: f64,
    pub user_ms: f64,
    pub kernel_ms: f64,
    pub working_set_mb: f64,
    pub private_mb: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RoleCpuBreakdown {
    pub role: String,
    pub process_count: usize,
    pub cpu_pct_total: f64,
    pub cpu_pct_single_core: f64,
    pub cpu_ms_per_sec: f64,
    pub user_ms: f64,
    pub kernel_ms: f64,
    pub working_set_mb: f64,
    pub private_mb: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ThreadCpuBreakdown {
    pub tid: u32,
    pub name: String,
    pub cpu_pct_total: f64,
    pub cpu_pct_single_core: f64,
    pub total_cpu_ms: f64,
    pub user_ms: f64,
    pub kernel_ms: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct CaptureSessionDelta {
    pub session_index: usize,
    pub backend: String,
    pub encoder: String,
    pub delta_callbacks: u64,
    pub delta_gated: u64,
    pub delta_images: u64,
    pub delta_nvenc_images: u64,
    pub delta_gpu_scaled_images: u64,
    pub callbacks_per_sec: f64,
    pub images_per_sec: f64,
    pub avg_readback_ms: f64,
    pub avg_jpeg_ms: f64,
    pub avg_nvenc_ms: f64,
    pub avg_resize_ms: f64,
    pub avg_processing_ms: f64,
    pub delta_queue_drops: u64,
    pub delta_missed_deadlines: u64,
    pub delta_nvenc_fallbacks: u64,
    pub delta_readback_errors: u64,
    pub delta_jpeg_errors: u64,
    pub max_queue_age_ms: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct NativePerfSummary {
    pub duration_ms: u64,
    pub p2sharer_avg_cpu_pct: f64,
    pub p2sharer_peak_cpu_pct: f64,
    pub p2sharer_cpu_ms_per_sec: f64,
    pub p2sharer_user_ms: f64,
    pub p2sharer_kernel_ms: f64,
    pub p2sharer_working_set_mb: f64,
    pub p2sharer_private_mb: f64,
    pub webview2_avg_cpu_pct: f64,
    pub webview2_peak_cpu_pct: f64,
    pub webview2_cpu_ms_per_sec: f64,
    pub webview2_user_ms: f64,
    pub webview2_kernel_ms: f64,
    pub webview2_working_set_mb: f64,
    pub webview2_private_mb: f64,
    pub combined_avg_cpu_pct: f64,
    pub combined_peak_cpu_pct: f64,
    pub system_avg_cpu_pct: f64,
    pub system_peak_cpu_pct: f64,
    pub webview2_process_count: usize,
    pub p2sharer_thread_count: usize,
    pub active_capture_count: usize,
    pub audio_capture_active: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct NativePerformanceReport {
    pub schema: u32,
    pub session_id: u64,
    pub started_epoch_ms: u64,
    pub finished_epoch_ms: u64,
    pub hardware: HardwareInfo,
    pub summary: NativePerfSummary,
    pub webview2_by_role: Vec<RoleCpuBreakdown>,
    pub processes: Vec<ProcessCpuBreakdown>,
    pub top_threads: Vec<ThreadCpuBreakdown>,
    pub capture_sessions: Vec<CaptureSessionDelta>,
    pub timeline: Vec<PerfDiagTickSample>,
}

fn round2(val: f64) -> f64 {
    if !val.is_finite() {
        return 0.0;
    }
    (val * 100.0).round() / 100.0
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn classify_process_role(exe_name: &str, cmd_args: &[String], is_self: bool) -> String {
    if is_self {
        return "p2sharer-native".to_string();
    }
    let lower_exe = exe_name.to_ascii_lowercase();
    if lower_exe.contains("webview2") || lower_exe.contains("msedge") {
        let mut proc_type: Option<String> = None;
        let mut utility_sub: Option<String> = None;
        for arg in cmd_args {
            if let Some(val) = arg.strip_prefix("--type=") {
                proc_type = Some(val.to_ascii_lowercase());
            } else if let Some(val) = arg.strip_prefix("--utility-sub-type=") {
                utility_sub = Some(val.to_ascii_lowercase());
            }
        }
        return match proc_type.as_deref() {
            None => "webview2-browser".to_string(),
            Some("renderer") => "webview2-renderer".to_string(),
            Some("gpu-process") => "webview2-gpu".to_string(),
            Some("crashpad-handler") => "webview2-crashpad".to_string(),
            Some("utility") => {
                if let Some(sub) = utility_sub {
                    if sub.contains("network") {
                        "webview2-utility-network".to_string()
                    } else if sub.contains("audio") {
                        "webview2-utility-audio".to_string()
                    } else if sub.contains("storage") {
                        "webview2-utility-storage".to_string()
                    } else {
                        "webview2-utility".to_string()
                    }
                } else {
                    "webview2-utility".to_string()
                }
            }
            Some(other) => format!("webview2-{other}"),
        };
    }
    "child-helper".to_string()
}

fn compute_cpu_metrics(
    delta_kernel_100ns: u64,
    delta_user_100ns: u64,
    delta_wall_ms: f64,
    logical_cores: usize,
) -> (f64, f64, f64, f64, f64) {
    let kernel_ms = delta_kernel_100ns as f64 / 10_000.0;
    let user_ms = delta_user_100ns as f64 / 10_000.0;
    let total_cpu_ms = kernel_ms + user_ms;
    if delta_wall_ms <= 0.0 {
        return (0.0, 0.0, 0.0, round2(user_ms), round2(kernel_ms));
    }
    let cores = logical_cores.max(1) as f64;
    let cpu_pct_single_core = (total_cpu_ms / delta_wall_ms) * 100.0;
    let cpu_pct_total = cpu_pct_single_core / cores;
    let cpu_ms_per_sec = (total_cpu_ms / delta_wall_ms) * 1000.0;
    (
        round2(cpu_pct_total),
        round2(cpu_pct_single_core),
        round2(cpu_ms_per_sec),
        round2(user_ms),
        round2(kernel_ms),
    )
}

#[cfg(windows)]
fn probe_gpu_adapters() -> Vec<GpuAdapterInfo> {
    use windows_capture_api::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
    };

    let mut adapters = Vec::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
            return adapters;
        };
        let mut idx = 0u32;
        while let Ok(adapter) = factory.EnumAdapters1(idx) {
            idx += 1;
            if let Ok(desc) = adapter.GetDesc1() {
                let nul_pos = desc
                    .Description
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(desc.Description.len());
                let name = String::from_utf16_lossy(&desc.Description[..nul_pos]).trim().to_string();
                let is_software = (desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32)) != 0;
                adapters.push(GpuAdapterInfo {
                    description: name,
                    vendor_id: desc.VendorId,
                    device_id: desc.DeviceId,
                    dedicated_vram_mb: (desc.DedicatedVideoMemory as u64) / (1024 * 1024),
                    shared_memory_mb: (desc.SharedSystemMemory as u64) / (1024 * 1024),
                    is_software,
                });
            }
            if idx >= 8 {
                break;
            }
        }
    }
    adapters
}

#[cfg(not(windows))]
fn probe_gpu_adapters() -> Vec<GpuAdapterInfo> {
    Vec::new()
}

fn collect_hardware_info(sys: &mut System) -> HardwareInfo {
    sys.refresh_cpu_specifics(CpuRefreshKind::everything());
    sys.refresh_memory_specifics(MemoryRefreshKind::everything());

    let cpus = sys.cpus();
    let cpu_brand = cpus
        .first()
        .map(|c| c.brand().trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Unknown CPU".to_string());
    let cpu_frequency_mhz = cpus.first().map(|c| c.frequency()).unwrap_or(0);
    let cpu_logical_cores = cpus.len().max(1);
    let cpu_physical_cores = sys.physical_core_count().unwrap_or(cpu_logical_cores);

    let total_ram_mb = sys.total_memory() / (1024 * 1024);
    let available_ram_mb = sys.available_memory() / (1024 * 1024);
    let used_ram_mb = sys.used_memory() / (1024 * 1024);

    #[cfg(windows)]
    let nvenc_probe = crate::video_nvenc::probe_session();
    #[cfg(not(windows))]
    let nvenc_probe: Result<(), String> = Err("Native NVENC requires Windows".to_string());

    let (native_nvenc_available, native_encoder_note) = match nvenc_probe {
        Ok(()) => (true, "NVENC driver API available".to_string()),
        Err(reason) => (false, format!("NVENC unavailable: {reason}")),
    };

    HardwareInfo {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        build_mode: if cfg!(debug_assertions) { "debug" } else { "release" },
        arch: std::env::consts::ARCH,
        os_name: System::name().unwrap_or_else(|| "Windows".to_string()),
        os_version: System::os_version().unwrap_or_else(|| "Unknown".to_string()),
        cpu_brand,
        cpu_logical_cores,
        cpu_physical_cores,
        cpu_frequency_mhz,
        total_ram_mb,
        available_ram_mb,
        used_ram_mb,
        gpu_adapters: probe_gpu_adapters(),
        native_nvenc_available,
        native_encoder_note,
    }
}

#[cfg(windows)]
fn filetime_to_u64(ft: windows::Win32::Foundation::FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
}

#[cfg(windows)]
fn snapshot_process_tree(sys: &mut System) -> HashMap<u32, ProcessSample> {
    use std::mem::size_of;
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let self_pid = std::process::id();
    let mut all_entries: Vec<(u32, u32, String)> = Vec::new();

    unsafe {
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut entry = PROCESSENTRY32W {
                dwSize: size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snap, &mut entry).is_ok() {
                loop {
                    let nul = entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let exe = String::from_utf16_lossy(&entry.szExeFile[..nul]);
                    all_entries.push((entry.th32ProcessID, entry.th32ParentProcessID, exe));
                    if Process32NextW(snap, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
    }

    // Collect self_pid + all descendant PIDs (BFS).
    let mut tree_pids: HashSet<u32> = HashSet::new();
    tree_pids.insert(self_pid);
    loop {
        let mut added = false;
        for &(pid, ppid, _) in &all_entries {
            if tree_pids.contains(&ppid) && tree_pids.insert(pid) {
                added = true;
            }
        }
        if !added {
            break;
        }
    }

    // Refresh only our tree PIDs in sysinfo to read command lines for role classification.
    let sys_pids: Vec<sysinfo::Pid> = tree_pids.iter().map(|&p| sysinfo::Pid::from_u32(p)).collect();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&sys_pids),
        false,
        ProcessRefreshKind::new().with_cmd(sysinfo::UpdateKind::OnlyIfNotSet),
    );

    let mut samples = HashMap::new();
    for (pid, _ppid, exe_name) in all_entries {
        if !tree_pids.contains(&pid) {
            continue;
        }
        let cmd_args: Vec<String> = sys
            .process(sysinfo::Pid::from_u32(pid))
            .map(|p| {
                p.cmd()
                    .iter()
                    .map(|s| s.to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();

        let role = classify_process_role(&exe_name, &cmd_args, pid == self_pid);

        let mut kernel_100ns = 0u64;
        let mut user_100ns = 0u64;
        let mut working_set_bytes = 0u64;
        let mut private_bytes = 0u64;

        unsafe {
            if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut creation = FILETIME::default();
                let mut exit = FILETIME::default();
                let mut kernel = FILETIME::default();
                let mut user = FILETIME::default();
                if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user).is_ok() {
                    kernel_100ns = filetime_to_u64(kernel);
                    user_100ns = filetime_to_u64(user);
                }

                let mut mem = PROCESS_MEMORY_COUNTERS_EX {
                    cb: size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
                    ..Default::default()
                };
                if GetProcessMemoryInfo(
                    handle,
                    (&mut mem as *mut PROCESS_MEMORY_COUNTERS_EX).cast(),
                    size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
                )
                .is_ok()
                {
                    working_set_bytes = mem.WorkingSetSize as u64;
                    private_bytes = mem.PrivateUsage as u64;
                }
                let _ = CloseHandle(handle);
            }
        }

        samples.insert(
            pid,
            ProcessSample {
                exe_name,
                role,
                kernel_100ns,
                user_100ns,
                working_set_bytes,
                private_bytes,
            },
        );
    }

    samples
}

#[cfg(not(windows))]
fn snapshot_process_tree(_sys: &mut System) -> HashMap<u32, ProcessSample> {
    HashMap::new()
}

#[cfg(windows)]
fn snapshot_self_threads() -> HashMap<u32, ThreadSample> {
    use std::mem::size_of;
    use windows::Win32::Foundation::{CloseHandle, LocalFree, FILETIME, HLOCAL};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows::Win32::System::Threading::{
        GetThreadDescription, GetThreadTimes, OpenThread, THREAD_QUERY_LIMITED_INFORMATION,
    };

    let self_pid = std::process::id();
    let mut threads = HashMap::new();

    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) else {
            return threads;
        };
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        if Thread32First(snap, &mut entry).is_ok() {
            loop {
                if entry.th32OwnerProcessID == self_pid {
                    let tid = entry.th32ThreadID;
                    if let Ok(handle) = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, false, tid) {
                        let mut creation = FILETIME::default();
                        let mut exit = FILETIME::default();
                        let mut kernel = FILETIME::default();
                        let mut user = FILETIME::default();
                        if GetThreadTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user).is_ok() {
                            let name = match GetThreadDescription(handle) {
                                Ok(pwstr) => {
                                    let s = pwstr.to_string().unwrap_or_default();
                                    let _ = LocalFree(HLOCAL(pwstr.0 as *mut _));
                                    if s.trim().is_empty() {
                                        format!("thread-{tid}")
                                    } else {
                                        s.trim().to_string()
                                    }
                                }
                                Err(_) => format!("thread-{tid}"),
                            };
                            threads.insert(
                                tid,
                                ThreadSample {
                                    name,
                                    kernel_100ns: filetime_to_u64(kernel),
                                    user_100ns: filetime_to_u64(user),
                                },
                            );
                        }
                        let _ = CloseHandle(handle);
                    }
                }
                if Thread32Next(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }

    threads
}

#[cfg(not(windows))]
fn snapshot_self_threads() -> HashMap<u32, ThreadSample> {
    HashMap::new()
}

fn compute_capture_deltas(
    baseline: &[ActiveCaptureDiagnosticSnapshot],
    current: &[ActiveCaptureDiagnosticSnapshot],
    duration_secs: f64,
) -> Vec<CaptureSessionDelta> {
    let base_map: HashMap<usize, &ActiveCaptureDiagnosticSnapshot> =
        baseline.iter().map(|s| (s.session_index, s)).collect();
    let secs = duration_secs.max(0.001);

    current
        .iter()
        .map(|cur| {
            let prev = base_map.get(&cur.session_index).copied();
            let d_callbacks = cur.callbacks.saturating_sub(prev.map_or(0, |p| p.callbacks));
            let d_gated = cur.gated.saturating_sub(prev.map_or(0, |p| p.gated));
            let d_images = cur.images.saturating_sub(prev.map_or(0, |p| p.images));
            let d_nvenc_images = cur.nvenc_images.saturating_sub(prev.map_or(0, |p| p.nvenc_images));
            let d_gpu_scaled = cur.gpu_scaled_images.saturating_sub(prev.map_or(0, |p| p.gpu_scaled_images));
            let d_readback_us = cur.readback_us.saturating_sub(prev.map_or(0, |p| p.readback_us));
            let d_jpeg_us = cur.jpeg_us.saturating_sub(prev.map_or(0, |p| p.jpeg_us));
            let d_nvenc_us = cur.nvenc_us.saturating_sub(prev.map_or(0, |p| p.nvenc_us));
            let d_resize_us = cur.resize_us.saturating_sub(prev.map_or(0, |p| p.resize_us));
            let d_processing_us = cur.processing_us.saturating_sub(prev.map_or(0, |p| p.processing_us));

            let img_denom = d_images.max(1) as f64;
            let nvenc_denom = d_nvenc_images.max(1) as f64;

            CaptureSessionDelta {
                session_index: cur.session_index,
                backend: cur.backend.to_string(),
                encoder: cur.encoder.to_string(),
                delta_callbacks: d_callbacks,
                delta_gated: d_gated,
                delta_images: d_images,
                delta_nvenc_images: d_nvenc_images,
                delta_gpu_scaled_images: d_gpu_scaled,
                callbacks_per_sec: round2(d_callbacks as f64 / secs),
                images_per_sec: round2(d_images as f64 / secs),
                avg_readback_ms: if d_images > 0 { round2(d_readback_us as f64 / img_denom / 1000.0) } else { 0.0 },
                avg_jpeg_ms: if d_images > 0 { round2(d_jpeg_us as f64 / img_denom / 1000.0) } else { 0.0 },
                avg_nvenc_ms: if d_nvenc_images > 0 { round2(d_nvenc_us as f64 / nvenc_denom / 1000.0) } else { 0.0 },
                avg_resize_ms: if d_images > 0 { round2(d_resize_us as f64 / img_denom / 1000.0) } else { 0.0 },
                avg_processing_ms: if d_images > 0 { round2(d_processing_us as f64 / img_denom / 1000.0) } else { 0.0 },
                delta_queue_drops: cur.queue_drops.saturating_sub(prev.map_or(0, |p| p.queue_drops)),
                delta_missed_deadlines: cur.missed_deadlines.saturating_sub(prev.map_or(0, |p| p.missed_deadlines)),
                delta_nvenc_fallbacks: cur.nvenc_fallbacks.saturating_sub(prev.map_or(0, |p| p.nvenc_fallbacks)),
                delta_readback_errors: cur.readback_errors.saturating_sub(prev.map_or(0, |p| p.readback_errors)),
                delta_jpeg_errors: cur.jpeg_errors.saturating_sub(prev.map_or(0, |p| p.jpeg_errors)),
                max_queue_age_ms: round2(cur.max_queue_age_us as f64 / 1000.0),
            }
        })
        .collect()
}

#[tauri::command]
pub fn perf_diag_start(state: tauri::State<'_, PerformanceDiagState>) -> Result<PerfDiagStartResult, String> {
    let mut sys = System::new_with_specifics(
        RefreshKind::new()
            .with_cpu(CpuRefreshKind::everything())
            .with_memory(MemoryRefreshKind::everything()),
    );
    let hardware = collect_hardware_info(&mut sys);
    let baseline_processes = snapshot_process_tree(&mut sys);
    let baseline_threads = snapshot_self_threads();
    let baseline_captures = crate::screen_sources::active_capture_diagnostics();
    let started_epoch_ms = now_epoch_ms();
    let session_id = started_epoch_ms ^ (std::process::id() as u64);
    let now = Instant::now();

    let session = ActiveSession {
        session_id,
        started_at: now,
        started_epoch_ms,
        last_tick_at: now,
        hardware: hardware.clone(),
        prev_processes: baseline_processes.clone(),
        baseline_processes,
        baseline_threads,
        baseline_captures,
        sys,
        timeline: Vec::with_capacity(32),
        peak_p2sharer_cpu_pct: 0.0,
        peak_webview2_cpu_pct: 0.0,
        peak_combined_cpu_pct: 0.0,
        peak_system_cpu_pct: 0.0,
        system_cpu_sum: 0.0,
        system_cpu_samples: 0,
    };

    let mut guard = state.active.lock().map_err(|_| "Performance diagnostic lock poisoned".to_string())?;
    *guard = Some(session);

    Ok(PerfDiagStartResult {
        session_id,
        started_epoch_ms,
        hardware,
    })
}

#[tauri::command]
pub fn perf_diag_sample(state: tauri::State<'_, PerformanceDiagState>) -> Result<PerfDiagTickSample, String> {
    let mut guard = state.active.lock().map_err(|_| "Performance diagnostic lock poisoned".to_string())?;
    let session = guard.as_mut().ok_or_else(|| "No active performance diagnostic session".to_string())?;

    let now = Instant::now();
    let elapsed_ms = now.duration_since(session.started_at).as_millis() as u64;
    let delta_ms = now.duration_since(session.last_tick_at).as_millis().max(1) as u64;
    let delta_wall_ms = delta_ms as f64;
    session.last_tick_at = now;

    session.sys.refresh_cpu_usage();
    let system_cpu_pct = round2(session.sys.global_cpu_usage() as f64);
    session.system_cpu_sum += system_cpu_pct;
    session.system_cpu_samples += 1;
    if system_cpu_pct > session.peak_system_cpu_pct {
        session.peak_system_cpu_pct = system_cpu_pct;
    }

    let current = snapshot_process_tree(&mut session.sys);
    let self_pid = std::process::id();
    let cores = session.hardware.cpu_logical_cores;

    let mut p2sharer_cpu_pct = 0.0;
    let mut p2sharer_ws = 0u64;
    let mut webview2_cpu_pct = 0.0;
    let mut webview2_renderer_cpu_pct = 0.0;
    let mut webview2_gpu_cpu_pct = 0.0;
    let mut webview2_ws = 0u64;
    let mut webview2_count = 0usize;

    for (pid, cur) in &current {
        let prev = session.prev_processes.get(pid);
        let d_kernel = prev.map_or(0, |p| cur.kernel_100ns.saturating_sub(p.kernel_100ns));
        let d_user = prev.map_or(0, |p| cur.user_100ns.saturating_sub(p.user_100ns));
        let (cpu_pct, _, _, _, _) = compute_cpu_metrics(d_kernel, d_user, delta_wall_ms, cores);

        if *pid == self_pid {
            p2sharer_cpu_pct = cpu_pct;
            p2sharer_ws = cur.working_set_bytes;
        } else {
            webview2_count += 1;
            webview2_cpu_pct += cpu_pct;
            webview2_ws += cur.working_set_bytes;
            if cur.role == "webview2-renderer" {
                webview2_renderer_cpu_pct += cpu_pct;
            } else if cur.role == "webview2-gpu" {
                webview2_gpu_cpu_pct += cpu_pct;
            }
        }
    }

    p2sharer_cpu_pct = round2(p2sharer_cpu_pct);
    webview2_cpu_pct = round2(webview2_cpu_pct);
    webview2_renderer_cpu_pct = round2(webview2_renderer_cpu_pct);
    webview2_gpu_cpu_pct = round2(webview2_gpu_cpu_pct);
    let combined_cpu_pct = round2(p2sharer_cpu_pct + webview2_cpu_pct);

    if p2sharer_cpu_pct > session.peak_p2sharer_cpu_pct {
        session.peak_p2sharer_cpu_pct = p2sharer_cpu_pct;
    }
    if webview2_cpu_pct > session.peak_webview2_cpu_pct {
        session.peak_webview2_cpu_pct = webview2_cpu_pct;
    }
    if combined_cpu_pct > session.peak_combined_cpu_pct {
        session.peak_combined_cpu_pct = combined_cpu_pct;
    }

    session.prev_processes = current;

    let active_capture_count = crate::screen_sources::active_capture_diagnostics().len();
    let audio_capture_active = crate::audio_loopback::is_audio_capturing();

    let tick = PerfDiagTickSample {
        elapsed_ms,
        delta_ms,
        p2sharer_cpu_pct,
        webview2_cpu_pct,
        webview2_renderer_cpu_pct,
        webview2_gpu_cpu_pct,
        combined_cpu_pct,
        system_cpu_pct,
        p2sharer_working_set_mb: round2(p2sharer_ws as f64 / (1024.0 * 1024.0)),
        webview2_working_set_mb: round2(webview2_ws as f64 / (1024.0 * 1024.0)),
        webview2_process_count: webview2_count,
        active_capture_count,
        audio_capture_active,
    };

    if session.timeline.len() < MAX_TIMELINE_SAMPLES {
        session.timeline.push(tick.clone());
    }

    Ok(tick)
}

#[tauri::command]
pub fn perf_diag_finish(state: tauri::State<'_, PerformanceDiagState>) -> Result<NativePerformanceReport, String> {
    let mut guard = state.active.lock().map_err(|_| "Performance diagnostic lock poisoned".to_string())?;
    let mut session = guard.take().ok_or_else(|| "No active performance diagnostic session".to_string())?;

    let now = Instant::now();
    let duration_ms = now.duration_since(session.started_at).as_millis().max(1) as u64;
    let duration_wall_ms = duration_ms as f64;
    let finished_epoch_ms = now_epoch_ms();
    let cores = session.hardware.cpu_logical_cores;
    let self_pid = std::process::id();

    let final_processes = snapshot_process_tree(&mut session.sys);
    let final_threads = snapshot_self_threads();
    let final_captures = crate::screen_sources::active_capture_diagnostics();
    let audio_capture_active = crate::audio_loopback::is_audio_capturing();

    let mut processes_out: Vec<ProcessCpuBreakdown> = Vec::new();
    let mut role_accum: HashMap<String, (usize, u64, u64, u64, u64)> = HashMap::new();

    let mut p2_kernel = 0u64;
    let mut p2_user = 0u64;
    let mut p2_ws = 0u64;
    let mut p2_priv = 0u64;

    let mut wv_kernel = 0u64;
    let mut wv_user = 0u64;
    let mut wv_ws = 0u64;
    let mut wv_priv = 0u64;
    let mut wv_count = 0usize;

    for (pid, cur) in &final_processes {
        let base = session.baseline_processes.get(pid);
        let d_kernel = base.map_or(0, |b| cur.kernel_100ns.saturating_sub(b.kernel_100ns));
        let d_user = base.map_or(0, |b| cur.user_100ns.saturating_sub(b.user_100ns));
        let (cpu_pct, cpu_single, cpu_ms_s, user_ms, kernel_ms) =
            compute_cpu_metrics(d_kernel, d_user, duration_wall_ms, cores);

        if *pid == self_pid {
            p2_kernel = d_kernel;
            p2_user = d_user;
            p2_ws = cur.working_set_bytes;
            p2_priv = cur.private_bytes;
        } else {
            wv_count += 1;
            wv_kernel = wv_kernel.saturating_add(d_kernel);
            wv_user = wv_user.saturating_add(d_user);
            wv_ws = wv_ws.saturating_add(cur.working_set_bytes);
            wv_priv = wv_priv.saturating_add(cur.private_bytes);

            let entry = role_accum.entry(cur.role.clone()).or_insert((0, 0, 0, 0, 0));
            entry.0 += 1;
            entry.1 = entry.1.saturating_add(d_kernel);
            entry.2 = entry.2.saturating_add(d_user);
            entry.3 = entry.3.saturating_add(cur.working_set_bytes);
            entry.4 = entry.4.saturating_add(cur.private_bytes);
        }

        processes_out.push(ProcessCpuBreakdown {
            pid: *pid,
            exe_name: cur.exe_name.clone(),
            role: cur.role.clone(),
            cpu_pct_total: cpu_pct,
            cpu_pct_single_core: cpu_single,
            cpu_ms_per_sec: cpu_ms_s,
            user_ms,
            kernel_ms,
            working_set_mb: round2(cur.working_set_bytes as f64 / (1024.0 * 1024.0)),
            private_mb: round2(cur.private_bytes as f64 / (1024.0 * 1024.0)),
        });
    }

    processes_out.sort_by(|a, b| {
        b.cpu_pct_total
            .partial_cmp(&a.cpu_pct_total)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut webview2_by_role: Vec<RoleCpuBreakdown> = role_accum
        .into_iter()
        .map(|(role, (count, k, u, ws, priv_b))| {
            let (cpu_pct, cpu_single, cpu_ms_s, user_ms, kernel_ms) =
                compute_cpu_metrics(k, u, duration_wall_ms, cores);
            RoleCpuBreakdown {
                role,
                process_count: count,
                cpu_pct_total: cpu_pct,
                cpu_pct_single_core: cpu_single,
                cpu_ms_per_sec: cpu_ms_s,
                user_ms,
                kernel_ms,
                working_set_mb: round2(ws as f64 / (1024.0 * 1024.0)),
                private_mb: round2(priv_b as f64 / (1024.0 * 1024.0)),
            }
        })
        .collect();
    webview2_by_role.sort_by(|a, b| {
        b.cpu_pct_total
            .partial_cmp(&a.cpu_pct_total)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Thread breakdown for p2sharer.exe
    let mut threads_out: Vec<ThreadCpuBreakdown> = final_threads
        .iter()
        .map(|(tid, cur)| {
            let base = session.baseline_threads.get(tid);
            let d_kernel = base.map_or(cur.kernel_100ns, |b| cur.kernel_100ns.saturating_sub(b.kernel_100ns));
            let d_user = base.map_or(cur.user_100ns, |b| cur.user_100ns.saturating_sub(b.user_100ns));
            let (cpu_pct, cpu_single, _, user_ms, kernel_ms) =
                compute_cpu_metrics(d_kernel, d_user, duration_wall_ms, cores);
            ThreadCpuBreakdown {
                tid: *tid,
                name: cur.name.clone(),
                cpu_pct_total: cpu_pct,
                cpu_pct_single_core: cpu_single,
                total_cpu_ms: round2(user_ms + kernel_ms),
                user_ms,
                kernel_ms,
            }
        })
        .collect();
    threads_out.sort_by(|a, b| {
        b.total_cpu_ms
            .partial_cmp(&a.total_cpu_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let total_thread_count = threads_out.len();
    threads_out.truncate(MAX_TOP_THREADS);

    let (p2_avg_pct, _, p2_ms_s, p2_user_ms, p2_kernel_ms) =
        compute_cpu_metrics(p2_kernel, p2_user, duration_wall_ms, cores);
    let (wv_avg_pct, _, wv_ms_s, wv_user_ms, wv_kernel_ms) =
        compute_cpu_metrics(wv_kernel, wv_user, duration_wall_ms, cores);
    let combined_avg = round2(p2_avg_pct + wv_avg_pct);

    let system_avg_cpu_pct = if session.system_cpu_samples > 0 {
        round2(session.system_cpu_sum / session.system_cpu_samples as f64)
    } else {
        0.0
    };

    let capture_sessions = compute_capture_deltas(
        &session.baseline_captures,
        &final_captures,
        duration_wall_ms / 1000.0,
    );

    let summary = NativePerfSummary {
        duration_ms,
        p2sharer_avg_cpu_pct: p2_avg_pct,
        p2sharer_peak_cpu_pct: round2(session.peak_p2sharer_cpu_pct.max(p2_avg_pct)),
        p2sharer_cpu_ms_per_sec: p2_ms_s,
        p2sharer_user_ms: p2_user_ms,
        p2sharer_kernel_ms: p2_kernel_ms,
        p2sharer_working_set_mb: round2(p2_ws as f64 / (1024.0 * 1024.0)),
        p2sharer_private_mb: round2(p2_priv as f64 / (1024.0 * 1024.0)),
        webview2_avg_cpu_pct: wv_avg_pct,
        webview2_peak_cpu_pct: round2(session.peak_webview2_cpu_pct.max(wv_avg_pct)),
        webview2_cpu_ms_per_sec: wv_ms_s,
        webview2_user_ms: wv_user_ms,
        webview2_kernel_ms: wv_kernel_ms,
        webview2_working_set_mb: round2(wv_ws as f64 / (1024.0 * 1024.0)),
        webview2_private_mb: round2(wv_priv as f64 / (1024.0 * 1024.0)),
        combined_avg_cpu_pct: combined_avg,
        combined_peak_cpu_pct: round2(session.peak_combined_cpu_pct.max(combined_avg)),
        system_avg_cpu_pct,
        system_peak_cpu_pct: round2(session.peak_system_cpu_pct),
        webview2_process_count: wv_count,
        p2sharer_thread_count: total_thread_count,
        active_capture_count: capture_sessions.len(),
        audio_capture_active,
    };

    Ok(NativePerformanceReport {
        schema: 1,
        session_id: session.session_id,
        started_epoch_ms: session.started_epoch_ms,
        finished_epoch_ms,
        hardware: session.hardware,
        summary,
        webview2_by_role,
        processes: processes_out,
        top_threads: threads_out,
        capture_sessions,
        timeline: session.timeline,
    })
}

#[tauri::command]
pub fn perf_diag_cancel(state: tauri::State<'_, PerformanceDiagState>) -> Result<(), String> {
    let mut guard = state.active.lock().map_err(|_| "Performance diagnostic lock poisoned".to_string())?;
    *guard = None;
    Ok(())
}

#[tauri::command]
pub async fn export_performance_report(
    report_json: String,
    suggested_name: Option<String>,
) -> Result<Option<String>, String> {
    if report_json.len() > MAX_REPORT_BYTES {
        return Err("Performance report exceeds maximum export size.".to_string());
    }
    let file_name = suggested_name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("p2sharer-performance-{}.json", now_epoch_ms()));

    let path = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .add_filter("JSON", &["json"])
            .set_file_name(&file_name)
            .save_file()
    })
    .await
    .map_err(|e| format!("Failed to open save dialog: {e}"))?;

    let Some(target) = path else {
        return Ok(None);
    };
    fs::write(&target, report_json.as_bytes())
        .map_err(|e| format!("Failed to write performance report: {e}"))?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn save_performance_report_to_logs(report_json: String) -> Result<String, String> {
    if report_json.len() > MAX_REPORT_BYTES {
        return Err("Performance report exceeds maximum size.".to_string());
    }
    let log_dir = crate::logger::get_log_dir();
    fs::create_dir_all(&log_dir).map_err(|e| format!("Could not prepare log directory: {e}"))?;
    let target = log_dir.join(format!("performance-{}-{}.json", now_epoch_ms(), std::process::id()));
    fs::write(&target, report_json.as_bytes())
        .map_err(|e| format!("Could not write performance report: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_webview2_roles_from_command_line() {
        assert_eq!(
            classify_process_role("p2sharer.exe", &[], true),
            "p2sharer-native"
        );
        assert_eq!(
            classify_process_role("msedgewebview2.exe", &["msedgewebview2.exe".into()], false),
            "webview2-browser"
        );
        assert_eq!(
            classify_process_role(
                "msedgewebview2.exe",
                &["msedgewebview2.exe".into(), "--type=renderer".into()],
                false
            ),
            "webview2-renderer"
        );
        assert_eq!(
            classify_process_role(
                "msedgewebview2.exe",
                &["msedgewebview2.exe".into(), "--type=gpu-process".into()],
                false
            ),
            "webview2-gpu"
        );
        assert_eq!(
            classify_process_role(
                "msedgewebview2.exe",
                &[
                    "msedgewebview2.exe".into(),
                    "--type=utility".into(),
                    "--utility-sub-type=network.mojom.NetworkService".into(),
                ],
                false
            ),
            "webview2-utility-network"
        );
        assert_eq!(
            classify_process_role(
                "msedgewebview2.exe",
                &[
                    "msedgewebview2.exe".into(),
                    "--type=utility".into(),
                    "--utility-sub-type=audio.mojom.AudioService".into(),
                ],
                false
            ),
            "webview2-utility-audio"
        );
    }

    #[test]
    fn computes_cpu_percentages_correctly() {
        // 4 cores, 1000ms wall time, 1000ms total CPU time = 100% single core, 25% total.
        let (total_pct, single_pct, ms_per_sec, user_ms, kernel_ms) =
            compute_cpu_metrics(2_500_000, 7_500_000, 1000.0, 4);
        assert_eq!(total_pct, 25.0);
        assert_eq!(single_pct, 100.0);
        assert_eq!(ms_per_sec, 1000.0);
        assert_eq!(user_ms, 750.0);
        assert_eq!(kernel_ms, 250.0);
    }

    #[test]
    fn computes_capture_session_deltas() {
        let base = vec![ActiveCaptureDiagnosticSnapshot {
            session_index: 0,
            backend: "WGC",
            encoder: "NVENC/H264",
            callbacks: 100,
            gated: 10,
            images: 50,
            nvenc_images: 50,
            nvenc_us: 100_000,
            nvenc_fallbacks: 0,
            readback_us: 0,
            jpeg_us: 0,
            resize_us: 0,
            processing_us: 150_000,
            gpu_scaled_images: 50,
            staging_allocations: 0,
            readback_errors: 0,
            jpeg_errors: 0,
            paced_images: 50,
            repeat_ticks: 5,
            refresh_images: 2,
            queue_drops: 1,
            missed_deadlines: 0,
            max_queue_age_us: 4000,
        }];
        let cur = vec![ActiveCaptureDiagnosticSnapshot {
            callbacks: 220,
            gated: 20,
            images: 110,
            nvenc_images: 110,
            nvenc_us: 220_000,
            processing_us: 330_000,
            gpu_scaled_images: 110,
            queue_drops: 3,
            max_queue_age_us: 6500,
            ..base[0].clone()
        }];
        let deltas = compute_capture_deltas(&base, &cur, 2.0);
        assert_eq!(deltas.len(), 1);
        assert_eq!(deltas[0].delta_callbacks, 120);
        assert_eq!(deltas[0].delta_images, 60);
        assert_eq!(deltas[0].images_per_sec, 30.0);
        assert_eq!(deltas[0].avg_nvenc_ms, 2.0);
        assert_eq!(deltas[0].avg_processing_ms, 3.0);
        assert_eq!(deltas[0].delta_queue_drops, 2);
        assert_eq!(deltas[0].max_queue_age_ms, 6.5);
    }

    #[cfg(windows)]
    #[test]
    fn snapshots_current_process_and_threads() {
        let mut sys = System::new_with_specifics(
            RefreshKind::new()
                .with_cpu(CpuRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything()),
        );
        let procs = snapshot_process_tree(&mut sys);
        let self_pid = std::process::id();
        assert!(procs.contains_key(&self_pid));
        assert_eq!(procs[&self_pid].role, "p2sharer-native");
        let threads = snapshot_self_threads();
        assert!(!threads.is_empty());
    }
}
