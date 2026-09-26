use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use byteorder::{ByteOrder, LittleEndian};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AudioConfig {
    #[serde(default = "default_mode")]
    pub mode: String, // "full", "exclude", "include"
    #[serde(default)]
    pub target_pids: Vec<u32>,
    #[serde(default)]
    pub target_names: Vec<String>,
    #[serde(default = "default_sample_rate")]
    pub sample_rate: u32,
}

fn default_mode() -> String {
    "exclude".to_string()
}

fn default_sample_rate() -> u32 {
    48000
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AudioStreamPayload {
    pub pcm_base64: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub rms_level: f32,
    #[serde(default)]
    pub timestamp_us: u64,
}

#[derive(Debug, Clone)]
pub struct AudioResampler {
    in_rate: u32,
    out_rate: u32,
    channels: usize,
    phase: f64,
    last_frame: Option<[f32; 2]>,
}

impl AudioResampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        Self {
            in_rate,
            out_rate,
            channels: 2,
            phase: 0.0,
            last_frame: None,
        }
    }

    pub fn in_rate(&self) -> u32 {
        self.in_rate
    }

    pub fn out_rate(&self) -> u32 {
        self.out_rate
    }

    pub fn phase(&self) -> f64 {
        self.phase
    }

    pub fn last_frame(&self) -> Option<[f32; 2]> {
        self.last_frame
    }

    pub fn resample(&mut self, input: &[f32], output: &mut Vec<f32>) {
        if self.in_rate == self.out_rate {
            output.extend_from_slice(input);
            return;
        }

        let in_frames = input.len() / self.channels;
        if in_frames == 0 {
            return;
        }

        let ratio = self.in_rate as f64 / self.out_rate as f64;

        while self.phase + 1e-9 < in_frames as f64 {
            let in_idx = self.phase.floor() as usize;
            let frac = (self.phase - in_idx as f64) as f32;

            let (s0_l, s0_r) = (
                input[in_idx * 2],
                input[in_idx * 2 + 1],
            );

            let (s1_l, s1_r) = if in_idx + 1 < in_frames {
                (input[(in_idx + 1) * 2], input[(in_idx + 1) * 2 + 1])
            } else {
                (s0_l, s0_r)
            };

            let out_l = s0_l + frac * (s1_l - s0_l);
            let out_r = s0_r + frac * (s1_r - s0_r);

            output.push(out_l);
            output.push(out_r);

            self.phase += ratio;
        }

        self.phase -= in_frames as f64;
        self.last_frame = Some([input[(in_frames - 1) * 2], input[(in_frames - 1) * 2 + 1]]);
    }

    pub fn reset(&mut self) {
        self.phase = 0.0;
        self.last_frame = None;
    }
}

pub fn resample_interleaved_float(
    input: &[f32],
    channels: u16,
    in_sample_rate: u32,
    out_sample_rate: u32,
) -> Vec<f32> {
    if in_sample_rate == out_sample_rate || input.is_empty() {
        return input.to_vec();
    }

    let ch = channels as usize;
    if ch == 0 {
        return Vec::new();
    }
    let in_frames = input.len() / ch;
    if in_frames == 0 {
        return Vec::new();
    }
    let out_frames = ((in_frames as u64 * out_sample_rate as u64 + in_sample_rate as u64 / 2)
        / in_sample_rate as u64) as usize;
    if out_frames == 0 {
        return Vec::new();
    }

    let mut output = Vec::with_capacity(out_frames * ch);
    let ratio = if out_frames <= 1 {
        0.0
    } else {
        (in_frames - 1) as f64 / (out_frames - 1) as f64
    };

    for out_frame in 0..out_frames {
        let in_pos = out_frame as f64 * ratio;
        let in_frame0 = in_pos.floor() as usize;
        let in_frame1 = (in_frame0 + 1).min(in_frames.saturating_sub(1));
        let frac = (in_pos - in_frame0 as f64) as f32;

        for c in 0..ch {
            let s0 = input[in_frame0 * ch + c];
            let s1 = input[in_frame1 * ch + c];
            output.push(s0 + frac * (s1 - s0));
        }
    }

    output
}

pub fn convert_and_downmix_to_stereo(
    data_ptr: *const u8,
    num_frames: usize,
    in_channels: u16,
    bits_per_sample: u16,
    is_silent: bool,
    out_stereo: &mut Vec<f32>,
) {
    if num_frames == 0 {
        return;
    }
    if is_silent || data_ptr.is_null() {
        out_stereo.extend(std::iter::repeat_n(0.0f32, num_frames * 2));
        return;
    }

    const INV_SQRT2: f32 = std::f32::consts::FRAC_1_SQRT_2;

    match (in_channels, bits_per_sample) {
        (2, 32) => {
            // Stereo 32-bit float: Fast copy
            let slice = unsafe {
                std::slice::from_raw_parts(data_ptr as *const f32, num_frames * 2)
            };
            out_stereo.extend_from_slice(slice);
        }
        (1, 32) => {
            // Mono 32-bit float: Duplicate to Left and Right
            let slice = unsafe {
                std::slice::from_raw_parts(data_ptr as *const f32, num_frames)
            };
            out_stereo.reserve(num_frames * 2);
            for &s in slice {
                let clamped = s.clamp(-1.0, 1.0);
                out_stereo.push(clamped);
                out_stereo.push(clamped);
            }
        }
        (2, 16) => {
            // Stereo 16-bit integer PCM: Normalize to [-1.0, 1.0]
            let slice = unsafe {
                std::slice::from_raw_parts(data_ptr as *const i16, num_frames * 2)
            };
            out_stereo.reserve(num_frames * 2);
            for &s in slice {
                out_stereo.push((s as f32 / 32768.0).clamp(-1.0, 1.0));
            }
        }
        (1, 16) => {
            // Mono 16-bit integer PCM: Normalize and duplicate
            let slice = unsafe {
                std::slice::from_raw_parts(data_ptr as *const i16, num_frames)
            };
            out_stereo.reserve(num_frames * 2);
            for &s in slice {
                let f = (s as f32 / 32768.0).clamp(-1.0, 1.0);
                out_stereo.push(f);
                out_stereo.push(f);
            }
        }
        (6, 32) => {
            // 5.1 Surround (FL, FR, FC, LFE, BL, BR) -> ITU-R BS.775
            // L = FL + 0.7071*FC + 0.7071*BL
            // R = FR + 0.7071*FC + 0.7071*BR
            let slice = unsafe {
                std::slice::from_raw_parts(data_ptr as *const f32, num_frames * 6)
            };
            out_stereo.reserve(num_frames * 2);
            for frame in slice.chunks_exact(6) {
                let fl = frame[0];
                let fr = frame[1];
                let fc = frame[2];
                let bl = frame[4];
                let br = frame[5];
                out_stereo.push((fl + fc * INV_SQRT2 + bl * INV_SQRT2).clamp(-1.0, 1.0));
                out_stereo.push((fr + fc * INV_SQRT2 + br * INV_SQRT2).clamp(-1.0, 1.0));
            }
        }
        (6, 16) => {
            let slice = unsafe {
                std::slice::from_raw_parts(data_ptr as *const i16, num_frames * 6)
            };
            out_stereo.reserve(num_frames * 2);
            for frame in slice.chunks_exact(6) {
                let fl = frame[0] as f32 / 32768.0;
                let fr = frame[1] as f32 / 32768.0;
                let fc = frame[2] as f32 / 32768.0;
                let bl = frame[4] as f32 / 32768.0;
                let br = frame[5] as f32 / 32768.0;
                out_stereo.push((fl + fc * INV_SQRT2 + bl * INV_SQRT2).clamp(-1.0, 1.0));
                out_stereo.push((fr + fc * INV_SQRT2 + br * INV_SQRT2).clamp(-1.0, 1.0));
            }
        }
        (8, 32) => {
            // 7.1 Surround (FL, FR, FC, LFE, BL, BR, SL, SR)
            let slice = unsafe {
                std::slice::from_raw_parts(data_ptr as *const f32, num_frames * 8)
            };
            out_stereo.reserve(num_frames * 2);
            for frame in slice.chunks_exact(8) {
                let fl = frame[0];
                let fr = frame[1];
                let fc = frame[2];
                let bl = frame[4];
                let br = frame[5];
                let sl = frame[6];
                let sr = frame[7];
                out_stereo.push((fl + fc * INV_SQRT2 + (bl + sl) * 0.5).clamp(-1.0, 1.0));
                out_stereo.push((fr + fc * INV_SQRT2 + (br + sr) * 0.5).clamp(-1.0, 1.0));
            }
        }
        (8, 16) => {
            let slice = unsafe {
                std::slice::from_raw_parts(data_ptr as *const i16, num_frames * 8)
            };
            out_stereo.reserve(num_frames * 2);
            for frame in slice.chunks_exact(8) {
                let fl = frame[0] as f32 / 32768.0;
                let fr = frame[1] as f32 / 32768.0;
                let fc = frame[2] as f32 / 32768.0;
                let bl = frame[4] as f32 / 32768.0;
                let br = frame[5] as f32 / 32768.0;
                let sl = frame[6] as f32 / 32768.0;
                let sr = frame[7] as f32 / 32768.0;
                out_stereo.push((fl + fc * INV_SQRT2 + (bl + sl) * 0.5).clamp(-1.0, 1.0));
                out_stereo.push((fr + fc * INV_SQRT2 + (br + sr) * 0.5).clamp(-1.0, 1.0));
            }
        }
        (ch, 32) => {
            // Generic multi-channel float
            let slice = unsafe {
                std::slice::from_raw_parts(data_ptr as *const f32, num_frames * ch as usize)
            };
            out_stereo.reserve(num_frames * 2);
            for frame in slice.chunks_exact(ch as usize) {
                let l = frame[0].clamp(-1.0, 1.0);
                let r = if ch > 1 { frame[1].clamp(-1.0, 1.0) } else { l };
                out_stereo.push(l);
                out_stereo.push(r);
            }
        }
        (ch, 16) => {
            // Generic multi-channel 16-bit
            let slice = unsafe {
                std::slice::from_raw_parts(data_ptr as *const i16, num_frames * ch as usize)
            };
            out_stereo.reserve(num_frames * 2);
            for frame in slice.chunks_exact(ch as usize) {
                let l = (frame[0] as f32 / 32768.0).clamp(-1.0, 1.0);
                let r = if ch > 1 { (frame[1] as f32 / 32768.0).clamp(-1.0, 1.0) } else { l };
                out_stereo.push(l);
                out_stereo.push(r);
            }
        }
        _ => {
            out_stereo.extend(std::iter::repeat_n(0.0f32, num_frames * 2));
        }
    }
}

static CURRENT_STOP_FLAG: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

#[cfg(windows)]
pub(crate) mod win_audio {
    use super::*;
    use std::ptr::null_mut;
    use windows::core::{Interface, HRESULT, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

    pub(crate) const AUDCLNT_STREAMFLAGS_EVENTCALLBACK: u32 = 0x00040000;
    pub(crate) const AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM: u32 = 0x80000000;
    pub(crate) const AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY: u32 = 0x08000000;

    struct EventHandleGuard(HANDLE);

    impl Drop for EventHandleGuard {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    const AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK: u32 = 1;
    const PROCESS_LOOPBACK_MODE_INCLUDE_PROCESS_TREE: u32 = 0;
    const PROCESS_LOOPBACK_MODE_EXCLUDE_PROCESS_TREE: u32 = 1;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
        TargetProcessId: u32,
        ProcessLoopbackMode: u32,
    }

    #[repr(C)]
    #[allow(non_snake_case)]
    struct AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: u32,
        ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    }

    #[repr(C)]
    struct RawBlob {
        cb_size: u32,
        p_blob_data: *mut u8,
    }

    #[repr(C)]
    struct RawPropVariant {
        vt: u16,
        w_reserved1: u16,
        w_reserved2: u16,
        w_reserved3: u16,
        blob: RawBlob,
    }

    #[windows::core::implement(IActivateAudioInterfaceCompletionHandler)]
    struct AudioActivationHandler {
        sender: std::sync::Mutex<Option<std::sync::mpsc::Sender<Result<IAudioClient, String>>>>,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for AudioActivationHandler_Impl {
        fn ActivateCompleted(
            &self,
            operation: Option<&IActivateAudioInterfaceAsyncOperation>,
        ) -> windows::core::Result<()> {
            let Some(op) = operation else {
                if let Ok(mut guard) = self.sender.lock() {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(Err("ActivateCompleted called with None operation".to_string()));
                    }
                }
                return Ok(());
            };

            let mut hr = HRESULT(0);
            let mut unk = None;
            let res = unsafe { op.GetActivateResult(&mut hr, &mut unk) };
            if res.is_ok() && hr.is_ok() {
                if let Some(u) = unk {
                    if let Ok(client) = u.cast::<IAudioClient>() {
                        if let Ok(mut guard) = self.sender.lock() {
                            if let Some(tx) = guard.take() {
                                let _ = tx.send(Ok(client));
                            }
                        }
                        return Ok(());
                    }
                }
            }

            if let Ok(mut guard) = self.sender.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Err(format!(
                        "Audio activation failed: op.GetActivateResult={:?}, hr=0x{:08X}",
                        res, hr.0 as u32
                    )));
                }
            }
            Ok(())
        }
    }

    fn resolve_target_process_tree(target_names: &[String], target_pids: &[u32], mode: &str) -> u32 {
        let mut sys = sysinfo::System::new_all();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        let self_pid = std::process::id();
        let mut self_pids = vec![self_pid];
        let mut added = true;
        while added {
            added = false;
            for (pid, proc) in sys.processes() {
                let u = pid.as_u32();
                if !self_pids.contains(&u) {
                    if let Some(pp) = proc.parent() {
                        if self_pids.contains(&pp.as_u32()) {
                            self_pids.push(u);
                            added = true;
                        }
                    }
                }
            }
        }

        // Check if any msedgewebview2 processes belong to this user session/parent
        for (pid, proc) in sys.processes() {
            let u = pid.as_u32();
            let p_name = proc.name().to_string_lossy().to_lowercase();
            if (p_name.contains("msedgewebview2") || p_name.contains("p2sharer")) && !self_pids.contains(&u) {
                if let Some(pp) = proc.parent() {
                    if self_pids.contains(&pp.as_u32()) {
                        self_pids.push(u);
                    }
                }
            }
        }

        if mode == "full" || (target_names.is_empty() && target_pids.is_empty()) {
            return 0;
        }

        let normalized_names: Vec<String> = target_names.iter().map(|n| n.to_lowercase()).collect();
        let specifies_self = normalized_names.iter().any(|target| target.contains("p2sharer") || target.contains("msedgewebview2"))
            || target_pids.iter().any(|&p| self_pids.contains(&p));

        if specifies_self {
            // Find active audio session for self/webview if currently emitting sound
            unsafe {
                if let Ok(enumerator) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                    if let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
                        if let Ok(session_manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) {
                            if let Ok(session_enum) = session_manager.GetSessionEnumerator() {
                                if let Ok(count) = session_enum.GetCount() {
                                    for i in 0..count {
                                        if let Ok(control) = session_enum.GetSession(i) {
                                            if let Ok(control2) = control.cast::<IAudioSessionControl2>() {
                                                let s_pid = control2.GetProcessId().unwrap_or(0);
                                                if s_pid > 0 && (self_pids.contains(&s_pid) || sys.process(sysinfo::Pid::from_u32(s_pid)).map(|p| p.name().to_string_lossy().to_lowercase().contains("msedgewebview2")).unwrap_or(false)) {
                                                    println!("[Audio Loopback] Found active p2sharer audio session on PID {}", s_pid);
                                                    return s_pid;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            println!("[Audio Loopback] Isolating root p2sharer PID {}", self_pid);
            return self_pid;
        }

        // 1. Gather all candidate PIDs matching target names or explicit PIDs
        let mut candidate_pids: Vec<u32> = Vec::new();

        for &pid in target_pids {
            if pid > 0 && sys.process(sysinfo::Pid::from_u32(pid)).is_some() {
                candidate_pids.push(pid);
            }
        }

        for (pid, proc) in sys.processes() {
            let p_name = proc.name().to_string_lossy().to_lowercase();
            if normalized_names.iter().any(|target| p_name.contains(target) || target.contains(&p_name)) {
                let u = pid.as_u32();
                if !candidate_pids.contains(&u) {
                    candidate_pids.push(u);
                }
            }
        }

        if candidate_pids.is_empty() {
            return 0;
        }

        // 2. Find the top-most living root ancestor among candidates
        let mut root_pids: Vec<u32> = Vec::new();
        for &start_pid in &candidate_pids {
            let mut curr = sysinfo::Pid::from_u32(start_pid);
            let start_name = sys.process(curr).map(|p| p.name().to_string_lossy().to_lowercase());

            while let Some(proc) = sys.process(curr) {
                if let Some(parent_pid) = proc.parent() {
                    if let Some(parent_proc) = sys.process(parent_pid) {
                        let parent_name = parent_proc.name().to_string_lossy().to_lowercase();
                        if start_name.as_deref() == Some(&parent_name) || candidate_pids.contains(&parent_pid.as_u32()) {
                            curr = parent_pid;
                            continue;
                        }
                    }
                }
                break;
            }

            let r_u32 = curr.as_u32();
            if !root_pids.contains(&r_u32) {
                root_pids.push(r_u32);
            }
        }

        // 3. Prioritize process root that currently has an active audio session
        unsafe {
            if let Ok(enumerator) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                if let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
                    if let Ok(session_manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) {
                        if let Ok(session_enum) = session_manager.GetSessionEnumerator() {
                            if let Ok(count) = session_enum.GetCount() {
                                for i in 0..count {
                                    if let Ok(control) = session_enum.GetSession(i) {
                                        if let Ok(control2) = control.cast::<IAudioSessionControl2>() {
                                            let s_pid = control2.GetProcessId().unwrap_or(0);
                                            if candidate_pids.contains(&s_pid) {
                                                for &r in &root_pids {
                                                    let mut check = sysinfo::Pid::from_u32(s_pid);
                                                    while let Some(cp) = sys.process(check) {
                                                        if check.as_u32() == r {
                                                            return r;
                                                        }
                                                        if let Some(pp) = cp.parent() {
                                                            check = pp;
                                                        } else {
                                                            break;
                                                        }
                                                    }
                                                }
                                                return s_pid;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if !root_pids.is_empty() {
            root_pids[0]
        } else {
            0
        }
    }

    pub(crate) fn activate_process_loopback_client(pid: u32, exclude: bool) -> Result<IAudioClient, String> {
        unsafe {
            let (tx, rx) = std::sync::mpsc::channel();
            let handler_impl = AudioActivationHandler {
                sender: std::sync::Mutex::new(Some(tx)),
            };
            let handler: IActivateAudioInterfaceCompletionHandler = handler_impl.into();

            let mut params = Box::new(AUDIOCLIENT_ACTIVATION_PARAMS {
                ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: if exclude {
                        PROCESS_LOOPBACK_MODE_EXCLUDE_PROCESS_TREE
                    } else {
                        PROCESS_LOOPBACK_MODE_INCLUDE_PROCESS_TREE
                    },
                },
            });

            let prop_var = RawPropVariant {
                vt: 0x0041, // VT_BLOB
                w_reserved1: 0,
                w_reserved2: 0,
                w_reserved3: 0,
                blob: RawBlob {
                    cb_size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                    p_blob_data: params.as_mut() as *mut _ as *mut u8,
                },
            };

            let virtual_device_path: Vec<u16> =
                "VAD\\Process_Loopback\0".encode_utf16().collect();

            let res = ActivateAudioInterfaceAsync(
                PCWSTR(virtual_device_path.as_ptr()),
                &IAudioClient::IID,
                Some(&prop_var as *const _ as *const _),
                &handler,
            );

            if let Err(e) = res {
                return Err(format!("ActivateAudioInterfaceAsync failed: {:?}", e));
            }

            match rx.recv_timeout(std::time::Duration::from_millis(3000)) {
                Ok(Ok(client)) => Ok(client),
                Ok(Err(e)) => Err(e),
                Err(e) => Err(format!("Audio activation timeout: {:?}", e)),
            }
        }
    }

    pub fn run_capture_loop(app: AppHandle, config: AudioConfig, stop_flag: Arc<AtomicBool>) {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

            // Determine activation method based on PID / Name and mode
            let target_pid = resolve_target_process_tree(&config.target_names, &config.target_pids, &config.mode);
            let is_process_mode = target_pid > 0 && (config.mode == "exclude" || config.mode == "include");

            if config.mode == "include" && !is_process_mode {
                println!("[Audio Loopback] Include mode requested with no valid target; falling back to master loopback to prevent silence.");
            }

            let mut was_process_loopback = false;
            let audio_client: IAudioClient = if is_process_mode {
                let exclude = config.mode == "exclude";
                println!(
                    "[Audio Loopback] Activating Windows WASAPI Process Loopback (Root PID: {}, Mode: {})",
                    target_pid, config.mode
                );
                match activate_process_loopback_client(target_pid, exclude) {
                    Ok(client) => {
                        println!("[Audio Loopback] Successfully activated process loopback for PID {}", target_pid);
                        was_process_loopback = true;
                        client
                    }
                    Err(err) => {
                        eprintln!("[Audio Loopback] Process loopback activation failed ({}), falling back to master loopback", err);
                        match get_default_render_audio_client() {
                            Ok(c) => c,
                            Err(_) => {
                                CoUninitialize();
                                return;
                            }
                        }
                    }
                }
            } else {
                match get_default_render_audio_client() {
                    Ok(c) => c,
                    Err(err) => {
                        eprintln!("[Audio Loopback] Master audio client activation failed: {:?}", err);
                        CoUninitialize();
                        return;
                    }
                }
            };

            // Query mix format from default render device (process loopback doesn't implement GetMixFormat directly)
            let mut is_allocated_format = false;
            let mut mix_format_ptr: *mut WAVEFORMATEX = if let Ok(master_client) = get_default_render_audio_client() {
                master_client.GetMixFormat().unwrap_or(std::ptr::null_mut())
            } else {
                audio_client.GetMixFormat().unwrap_or(std::ptr::null_mut())
            };

            let mut fallback_format = WAVEFORMATEX {
                wFormatTag: 1, // WAVE_FORMAT_PCM
                nChannels: 2,
                nSamplesPerSec: 48000,
                nAvgBytesPerSec: 48000 * 2 * 2,
                nBlockAlign: 4,
                wBitsPerSample: 16,
                cbSize: 0,
            };

            if mix_format_ptr.is_null() {
                eprintln!("[Audio Loopback] Failed to retrieve valid mix format, using standard 48kHz stereo fallback.");
                mix_format_ptr = &mut fallback_format as *mut _;
            } else {
                is_allocated_format = true;
            }

            let mix_format = &*mix_format_ptr;
            let sample_rate = mix_format.nSamplesPerSec;
            let channels = mix_format.nChannels;
            let bits_per_sample = mix_format.wBitsPerSample;

            // WASAPI process loopback and endpoint loopback both require AUDCLNT_STREAMFLAGS_LOOPBACK
            let stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK
                | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

            let buffer_duration = 10_000_000i64; // 1 second buffer in 100ns units

            let mut active_client = audio_client;
            let mut init_res = active_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                stream_flags,
                buffer_duration,
                0,
                mix_format_ptr,
                None,
            );

            // Resilient fallback: If process loopback fails initialization, recover on master render client
            if init_res.is_err() && was_process_loopback {
                eprintln!(
                    "[Audio Loopback] Process loopback client initialization failed: {:?}. Recovering via master render client.",
                    init_res
                );
                if let Ok(master_client) = get_default_render_audio_client() {
                    init_res = master_client.Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        stream_flags,
                        buffer_duration,
                        0,
                        mix_format_ptr,
                        None,
                    );
                    if init_res.is_ok() {
                        println!("[Audio Loopback] Master audio client fallback initialized successfully.");
                        active_client = master_client;
                        was_process_loopback = false;
                    }
                }
            }

            if let Err(err) = init_res {
                eprintln!("[Audio Loopback] Failed to initialize audio client: {:?}", err);
                if is_allocated_format {
                    CoTaskMemFree(Some(mix_format_ptr as *const _));
                }
                CoUninitialize();
                return;
            }

            if is_allocated_format {
                CoTaskMemFree(Some(mix_format_ptr as *const _));
            }

            let audio_event = match CreateEventW(None, false, false, PCWSTR::null()) {
                Ok(handle) => handle,
                Err(err) => {
                    eprintln!("[Audio Loopback] Failed to create capture event: {:?}", err);
                    CoUninitialize();
                    return;
                }
            };
            let _event_guard = EventHandleGuard(audio_event);

            if let Err(err) = active_client.SetEventHandle(audio_event) {
                eprintln!("[Audio Loopback] Failed to set event handle: {:?}", err);
                CoUninitialize();
                return;
            }

            let capture_client: IAudioCaptureClient = match active_client.GetService() {
                Ok(c) => c,
                Err(err) => {
                    eprintln!("[Audio Loopback] Failed to get capture client: {:?}", err);
                    CoUninitialize();
                    return;
                }
            };

            if let Err(err) = active_client.Start() {
                eprintln!("[Audio Loopback] Failed to start audio client: {:?}", err);
                CoUninitialize();
                return;
            }

            println!(
                "[Audio Loopback] Windows WASAPI loopback capture active ({} Hz, {} channels, ProcessFilter: {})",
                sample_rate, channels, was_process_loopback
            );

            let stream_start = std::time::Instant::now();
            let mut resampler = AudioResampler::new(sample_rate, 48000);
            let mut raw_stereo_buffer: Vec<f32> = Vec::with_capacity(4096);
            let mut standardized_buffer: Vec<f32> = Vec::with_capacity(4096);

            while stop_flag.load(Ordering::Relaxed) {
                let wait_res = WaitForSingleObject(audio_event, 20);

                if wait_res == WAIT_OBJECT_0 {
                    let mut packet_size = match capture_client.GetNextPacketSize() {
                        Ok(s) => s,
                        Err(_) => break,
                    };

                    while packet_size > 0 {
                        let mut data_ptr: *mut u8 = null_mut();
                        let mut num_frames_read = 0u32;
                        let mut flags = 0u32;
                        let mut qpc_pos = 0u64;

                        let get_res = capture_client.GetBuffer(
                            &mut data_ptr,
                            &mut num_frames_read,
                            &mut flags,
                            None,
                            Some(&mut qpc_pos),
                        );

                        if get_res.is_ok() && num_frames_read > 0 && !data_ptr.is_null() {
                            let is_silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;

                            // Step 1: Format conversion & downmix to stereo f32
                            convert_and_downmix_to_stereo(
                                data_ptr,
                                num_frames_read as usize,
                                channels,
                                bits_per_sample,
                                is_silent,
                                &mut raw_stereo_buffer,
                            );

                            // Step 2: Resample to 48000 Hz if hardware is not 48 kHz
                            if sample_rate != 48000 {
                                resampler.resample(&raw_stereo_buffer, &mut standardized_buffer);
                            } else {
                                standardized_buffer.extend_from_slice(&raw_stereo_buffer);
                            }
                            raw_stereo_buffer.clear();

                            let _ = capture_client.ReleaseBuffer(num_frames_read);
                        } else if get_res.is_ok() && num_frames_read > 0 {
                            let _ = capture_client.ReleaseBuffer(num_frames_read);
                        }

                        packet_size = capture_client.GetNextPacketSize().unwrap_or(0);
                    }
                } else if wait_res == WAIT_TIMEOUT {
                    // Timeout: audio engine was silent during this 20ms slice.
                    continue;
                } else {
                    break;
                }

                // Step 3: Emit chunks of ~10ms (480 frames = 960 floats for stereo at 48kHz)
                let min_samples = 960;
                while standardized_buffer.len() >= min_samples {
                    let chunk_samples = &standardized_buffer[..min_samples];

                    let mut sum_sq = 0.0f32;
                    for &s in chunk_samples {
                        sum_sq += s * s;
                    }
                    let rms = (sum_sq / chunk_samples.len() as f32).sqrt().min(1.0);

                    let mut byte_vec = vec![0u8; min_samples * 4];
                    LittleEndian::write_f32_into(chunk_samples, &mut byte_vec);

                    let timestamp_us = stream_start.elapsed().as_micros() as u64;

                    let payload = AudioStreamPayload {
                        pcm_base64: BASE64.encode(&byte_vec),
                        sample_rate: 48000,
                        channels: 2,
                        rms_level: rms,
                        timestamp_us,
                    };

                    let _ = app.emit("p2sharer://audio-stream", payload);

                    standardized_buffer.drain(..min_samples);
                }
            }

            let _ = active_client.Stop();
            CoUninitialize();
            println!("[Audio Loopback] Audio loopback stopped cleanly.");
        }
    }

    pub(crate) fn get_default_render_audio_client() -> Result<IAudioClient, windows::core::Error> {
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let audio_client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
            Ok(audio_client)
        }
    }
}

#[tauri::command]
pub fn start_audio_capture(app: AppHandle, config: Option<AudioConfig>) -> Result<bool, String> {
    // 1. Stop any currently running capture loop
    if let Ok(mut guard) = CURRENT_STOP_FLAG.lock() {
        if let Some(flag) = guard.take() {
            flag.store(false, Ordering::SeqCst);
        }
    }

    let cfg = config.unwrap_or(AudioConfig {
        mode: "exclude".to_string(),
        target_pids: vec![],
        target_names: vec![],
        sample_rate: 48000,
    });

    let stop_flag = Arc::new(AtomicBool::new(true));
    let stop_clone = stop_flag.clone();

    if let Ok(mut guard) = CURRENT_STOP_FLAG.lock() {
        *guard = Some(stop_flag);
    }

    std::thread::spawn(move || {
        #[cfg(windows)]
        win_audio::run_capture_loop(app, cfg, stop_clone);
    });

    Ok(true)
}

#[tauri::command]
pub fn stop_audio_capture() -> Result<bool, String> {
    if let Ok(mut guard) = CURRENT_STOP_FLAG.lock() {
        if let Some(flag) = guard.take() {
            flag.store(false, Ordering::SeqCst);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_repeat_n_silence_buffer() {
        let mut buffer: Vec<f32> = Vec::new();
        let total_samples = 480;
        buffer.extend(std::iter::repeat_n(0.0f32, total_samples));
        assert_eq!(buffer.len(), 480);
        assert!(buffer.iter().all(|&s| s == 0.0f32));
    }

    #[cfg(windows)]
    #[test]
    fn test_process_loopback_activation_and_init() {
        unsafe {
            use windows::core::PCWSTR;
            use windows::Win32::Foundation::CloseHandle;
            use windows::Win32::Media::Audio::*;
            use windows::Win32::System::Com::*;
            use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let my_pid = std::process::id();
            let client_res = win_audio::activate_process_loopback_client(my_pid, true);
            assert!(client_res.is_ok(), "Process loopback activation must succeed for valid PID");

            if let Ok(client) = client_res {
                let master = win_audio::get_default_render_audio_client();
                if let Ok(master_client) = master {
                    let mix_format = master_client.GetMixFormat().unwrap();

                    // Regression test: Without AUDCLNT_STREAMFLAGS_LOOPBACK, WASAPI rejects with AUDCLNT_E_INVALID_STREAM_FLAG (0x88890021)
                    let flags_without = win_audio::AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                        | win_audio::AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                        | win_audio::AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
                    let res_without = client.Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        flags_without,
                        10_000_000,
                        0,
                        mix_format,
                        None,
                    );
                    assert!(res_without.is_err(), "Initialize without LOOPBACK must be rejected");

                    // With AUDCLNT_STREAMFLAGS_LOOPBACK, initialization and capture pipeline must succeed
                    if let Ok(client2) = win_audio::activate_process_loopback_client(my_pid, true) {
                        let flags_with = AUDCLNT_STREAMFLAGS_LOOPBACK
                            | win_audio::AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                            | win_audio::AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                            | win_audio::AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
                        let res_with = client2.Initialize(
                            AUDCLNT_SHAREMODE_SHARED,
                            flags_with,
                            10_000_000,
                            0,
                            mix_format,
                            None,
                        );
                        assert!(res_with.is_ok(), "Initialize with LOOPBACK must succeed");

                        let event = CreateEventW(None, false, false, PCWSTR::null()).unwrap();
                        let set_ev_res = client2.SetEventHandle(event);
                        assert!(set_ev_res.is_ok(), "SetEventHandle must succeed");

                        let cap_res: windows::core::Result<IAudioCaptureClient> = client2.GetService();
                        assert!(cap_res.is_ok(), "GetService must succeed");

                        let start_res = client2.Start();
                        assert!(start_res.is_ok(), "Start must succeed");

                        let _ = WaitForSingleObject(event, 20);

                        let stop_res = client2.Stop();
                        assert!(stop_res.is_ok(), "Stop must succeed");

                        let _ = CloseHandle(event);
                    }
                }
            }
        }
    }
}

