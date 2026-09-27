use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use sysinfo::{Components, CpuRefreshKind, ProcessesToUpdate, RefreshKind, System};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProcessTelemetry {
    pub pid: u32,
    pub name: String,
    pub role: String,
    pub cpu_pct: f32,
    pub memory_mb: f64,
    pub threads: u32,
    pub run_time_secs: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CpuCoreTelemetry {
    pub id: usize,
    pub usage_pct: f32,
    pub frequency_mhz: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GpuTelemetry {
    pub name: String,
    pub temperature_c: Option<u32>,
    pub utilization_gpu_pct: Option<u32>,
    pub utilization_encoder_pct: Option<u32>,
    pub utilization_decoder_pct: Option<u32>,
    pub power_watts: Option<f32>,
    pub fan_speed_pct: Option<u32>,
    pub memory_used_mb: Option<u64>,
    pub memory_total_mb: Option<u64>,
    pub query_source: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SubsystemTelemetry {
    pub is_screen_capturing: bool,
    pub active_wgc: bool,
    pub ws_port: u16,
    pub is_audio_capturing: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SystemTelemetryReport {
    pub timestamp_ms: u64,
    pub cpu_global_pct: f32,
    pub cpu_cores: Vec<CpuCoreTelemetry>,
    pub cpu_temperature_c: Option<f32>,
    pub memory_used_mb: u64,
    pub memory_total_mb: u64,
    pub p2sharer_processes: Vec<ProcessTelemetry>,
    pub total_p2sharer_cpu_pct: f32,
    pub total_p2sharer_memory_mb: f64,
    pub total_p2sharer_threads: u32,
    pub gpu: Option<GpuTelemetry>,
    pub subsystems: SubsystemTelemetry,
}

static SYSTEM_INSTANCE: Mutex<Option<System>> = Mutex::new(None);

#[cfg(windows)]
fn get_process_thread_counts() -> HashMap<u32, u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, THREADENTRY32, TH32CS_SNAPTHREAD,
    };

    let mut counts = HashMap::new();
    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) {
            Ok(s) => s,
            Err(_) => return counts,
        };

        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };

        if Thread32First(snapshot, &mut entry).is_ok() {
            loop {
                *counts.entry(entry.th32OwnerProcessID).or_insert(0) += 1;
                if Thread32Next(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    counts
}

#[cfg(not(windows))]
fn get_process_thread_counts() -> HashMap<u32, u32> {
    HashMap::new()
}

static NVIDIA_AVAILABLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

fn query_gpu_telemetry() -> Option<GpuTelemetry> {
    #[cfg(windows)]
    {
        if !NVIDIA_AVAILABLE.load(std::sync::atomic::Ordering::Relaxed) {
            return None;
        }

        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let output = Command::new("nvidia-smi")
            .args([
                "--query-gpu=name,temperature.gpu,utilization.gpu,utilization.encoder,utilization.decoder,power.draw,fan.speed,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        match output {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let first_line = stdout.lines().next().unwrap_or("").trim();
                let parts: Vec<&str> = first_line.split(',').map(|s| s.trim()).collect();
                if parts.len() >= 9 {
                    return Some(GpuTelemetry {
                        name: parts[0].to_string(),
                        temperature_c: parts[1].parse().ok(),
                        utilization_gpu_pct: parts[2].parse().ok(),
                        utilization_encoder_pct: parts[3].parse().ok(),
                        utilization_decoder_pct: parts[4].parse().ok(),
                        power_watts: parts[5].parse().ok(),
                        fan_speed_pct: parts[6].parse().ok(),
                        memory_used_mb: parts[7].parse().ok(),
                        memory_total_mb: parts[8].parse().ok(),
                        query_source: "nvidia-smi".to_string(),
                    });
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                NVIDIA_AVAILABLE.store(false, std::sync::atomic::Ordering::Relaxed);
            }
            _ => {}
        }
    }
    None
}

fn classify_webview_role(cmd: &[std::ffi::OsString], name: &str) -> String {
    let cmd_str = cmd
        .iter()
        .map(|s| s.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(" ");

    if name.to_lowercase().contains("p2sharer") {
        return "Host Rust (p2sharer.exe)".to_string();
    }

    if cmd_str.contains("--type=gpu-process") {
        return "WebView2: Processo GPU (D3D11/Aceleração)".to_string();
    }
    if cmd_str.contains("--type=renderer") {
        return "WebView2: Renderer (DOM/Página/Vídeo)".to_string();
    }
    if cmd_str.contains("--type=utility") {
        if cmd_str.contains("sub-type=audio.mojom.AudioService") {
            return "WebView2: Utilitário (Áudio)".to_string();
        }
        if cmd_str.contains("sub-type=network.mojom.NetworkService") {
            return "WebView2: Utilitário (Rede)".to_string();
        }
        return "WebView2: Utilitário (Serviços)".to_string();
    }
    if cmd_str.contains("--type=crashpad-handler") {
        return "WebView2: Crashpad Handler".to_string();
    }

    "WebView2: Browser Host (Gerenciador)".to_string()
}

#[tauri::command]
pub fn get_system_telemetry() -> SystemTelemetryReport {
    let mut guard = SYSTEM_INSTANCE.lock().unwrap();

    let sys = guard.get_or_insert_with(|| {
        let mut s = System::new_with_specifics(
            RefreshKind::new()
                .with_cpu(CpuRefreshKind::everything())
                .with_processes(sysinfo::ProcessRefreshKind::new().with_cpu().with_memory())
                .with_memory(sysinfo::MemoryRefreshKind::everything()),
        );
        s.refresh_all();
        std::thread::sleep(std::time::Duration::from_millis(50));
        s.refresh_all();
        s
    });

    sys.refresh_cpu_all();
    sys.refresh_memory();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::new().with_cpu().with_memory(),
    );

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let cpu_global_pct = sys.global_cpu_usage();
    let cpu_cores: Vec<CpuCoreTelemetry> = sys
        .cpus()
        .iter()
        .enumerate()
        .map(|(idx, cpu)| CpuCoreTelemetry {
            id: idx,
            usage_pct: cpu.cpu_usage(),
            frequency_mhz: cpu.frequency(),
        })
        .collect();

    // Query CPU temperature from Components
    let components = Components::new_with_refreshed_list();
    let mut cpu_temp: Option<f32> = None;
    for comp in &components {
        let label = comp.label().to_lowercase();
        if label.contains("cpu")
            || label.contains("core")
            || label.contains("package")
            || label.contains("tctl")
            || label.contains("tdie")
        {
            let t = comp.temperature();
            if t > 0.0 {
                cpu_temp = Some(cpu_temp.map_or(t, |c| c.max(t)));
            }
        }
    }

    let memory_used_mb = sys.used_memory() / (1024 * 1024);
    let memory_total_mb = sys.total_memory() / (1024 * 1024);

    let thread_counts = get_process_thread_counts();
    let root_pid = std::process::id();

    // Identify P2Sharer & WebView2 processes
    let mut p2sharer_processes: Vec<ProcessTelemetry> = Vec::new();
    let mut total_p2sharer_cpu_pct = 0.0f32;
    let mut total_p2sharer_memory_mb = 0.0f64;
    let mut total_p2sharer_threads = 0u32;

    for (p_pid, proc) in sys.processes() {
        let raw_pid = p_pid.as_u32();
        let name = proc.name().to_string_lossy().to_string();
        let name_lower = name.to_lowercase();

        let is_root = raw_pid == root_pid;
        let is_p2sharer_exe = name_lower.contains("p2sharer");
        let is_webview2 = name_lower.contains("msedgewebview2");

        let matches = if is_root || is_p2sharer_exe {
            true
        } else if is_webview2 {
            // Check if parent is root or another WebView2 child
            let parent_pid = proc.parent().map(|p| p.as_u32()).unwrap_or(0);
            let cmd_str = proc
                .cmd()
                .iter()
                .map(|s| s.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(" ");

            parent_pid == root_pid
                || cmd_str.contains("p2sharer")
                || cmd_str.contains("P2Sharer")
        } else {
            false
        };

        if matches {
            let role = classify_webview_role(proc.cmd(), &name);
            let cpu_pct = proc.cpu_usage();
            let memory_mb = (proc.memory() as f64) / (1024.0 * 1024.0);
            let threads = *thread_counts.get(&raw_pid).unwrap_or(&0);
            let run_time_secs = proc.run_time();

            total_p2sharer_cpu_pct += cpu_pct;
            total_p2sharer_memory_mb += memory_mb;
            total_p2sharer_threads += threads;

            p2sharer_processes.push(ProcessTelemetry {
                pid: raw_pid,
                name,
                role,
                cpu_pct,
                memory_mb,
                threads,
                run_time_secs,
            });
        }
    }

    // Sort processes: Root Host first, then GPU process, then Renderer, then by CPU usage
    p2sharer_processes.sort_by(|a, b| {
        let score = |p: &ProcessTelemetry| {
            if p.pid == root_pid {
                0
            } else if p.role.contains("GPU") {
                1
            } else if p.role.contains("Renderer") {
                2
            } else if p.role.contains("Browser Host") {
                3
            } else {
                4
            }
        };
        score(a).cmp(&score(b)).then_with(|| {
            b.cpu_pct.partial_cmp(&a.cpu_pct).unwrap_or(std::cmp::Ordering::Equal)
        })
    });

    let gpu = query_gpu_telemetry();

    let subsystems = SubsystemTelemetry {
        is_screen_capturing: crate::screen_sources::is_video_capturing(),
        active_wgc: crate::screen_sources::is_wgc_active(),
        ws_port: crate::screen_sources::get_video_ws_port(),
        is_audio_capturing: crate::audio_loopback::is_audio_capturing(),
    };

    SystemTelemetryReport {
        timestamp_ms: now_ms,
        cpu_global_pct,
        cpu_cores,
        cpu_temperature_c: cpu_temp,
        memory_used_mb,
        memory_total_mb,
        p2sharer_processes,
        total_p2sharer_cpu_pct,
        total_p2sharer_memory_mb,
        total_p2sharer_threads,
        gpu,
        subsystems,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_system_telemetry_smoke() {
        let report = get_system_telemetry();
        assert!(report.timestamp_ms > 0);
        assert!(!report.cpu_cores.is_empty());
        assert!(report.memory_total_mb > 0);
        // Ensure root process is present in p2sharer_processes
        let root_pid = std::process::id();
        let found_root = report.p2sharer_processes.iter().any(|p| p.pid == root_pid);
        assert!(found_root, "Root process {} must be present in telemetry", root_pid);
    }
}
