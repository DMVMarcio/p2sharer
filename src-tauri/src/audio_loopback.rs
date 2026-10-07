use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use byteorder::{ByteOrder, LittleEndian};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
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

            let (s1_l, s1_r) = (
                input[in_idx * 2],
                input[in_idx * 2 + 1],
            );

            // Causal interpolation uses the preceding frame, including across
            // packet boundaries. This avoids guessing the next frame at each
            // chunk edge and makes output independent of WASAPI packet size.
            let (s0_l, s0_r) = if in_idx > 0 {
                (input[(in_idx - 1) * 2], input[(in_idx - 1) * 2 + 1])
            } else {
                let previous = self.last_frame.unwrap_or([s1_l, s1_r]);
                (previous[0], previous[1])
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

/// Drain every captured frame in device-clock order. Packet arrival time must
/// never add or remove PCM frames; the browser handles playout buffering.
pub fn drain_single_source_samples(
    fifo: &mut VecDeque<f32>,
    sample_rate: u32,
    resampler: &mut AudioResampler,
    scratch: &mut Vec<f32>,
    output: &mut Vec<f32>,
) {
    if fifo.is_empty() {
        return;
    }
    scratch.extend(fifo.drain(..));
    if sample_rate == 48000 {
        output.extend_from_slice(scratch);
    } else {
        resampler.resample(scratch, output);
    }
    scratch.clear();
}

pub fn mix_one_chunk(fifos: &mut [&mut VecDeque<f32>], frames: usize, output: &mut Vec<f32>) {
    for _ in 0..frames {
        let mut left = 0.0f32;
        let mut right = 0.0f32;
        let mut active_sources = 0usize;
        for fifo in fifos.iter_mut() {
            if fifo.len() >= 2 {
                let l = fifo.pop_front().unwrap_or(0.0);
                let r = fifo.pop_front().unwrap_or(0.0);
                left += l;
                right += r;
                if l.abs() > 0.0001 || r.abs() > 0.0001 {
                    active_sources += 1;
                }
            }
        }
        if active_sources > 1 {
            let headroom = 1.0 / (active_sources as f32).sqrt();
            left *= headroom;
            right *= headroom;
        }
        output.push(soft_clip_sample(left));
        output.push(soft_clip_sample(right));
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

/// Transparent broadcast soft-knee limiter.
/// Linearly transparent for normal signals (|x| <= 0.8 / -1.9 dBFS).
/// Smoothly saturates above 0.8 to prevent harsh digital clipping.
#[inline(always)]
pub fn soft_clip_sample(x: f32) -> f32 {
    let abs = x.abs();
    if abs <= 0.8 {
        x
    } else if abs <= 1.25 {
        let sign = x.signum();
        let norm = (abs - 0.8) / 0.45;
        let compressed = 0.8 + 0.2 * (norm - (norm * norm * norm) / 3.0);
        sign * compressed
    } else {
        let sign = x.signum();
        const JOIN_VALUE: f32 = 0.8 + 0.2 * (1.0 - 1.0 / 3.0);
        sign * (JOIN_VALUE + (1.0 - JOIN_VALUE) * (1.0 - (-1.8 * (abs - 1.25)).exp()))
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PcmEncoding {
    Float32,
    Integer,
}

pub fn convert_and_downmix_encoded(
    data_ptr: *const u8,
    num_frames: usize,
    channels: u16,
    bits_per_sample: u16,
    encoding: PcmEncoding,
    is_silent: bool,
    out_stereo: &mut Vec<f32>,
) {
    if is_silent || data_ptr.is_null() || num_frames == 0 {
        convert_and_downmix_to_stereo(data_ptr, num_frames, channels, bits_per_sample, true, out_stereo);
        return;
    }
    if bits_per_sample == 32 && encoding == PcmEncoding::Integer {
        let samples = unsafe { std::slice::from_raw_parts(data_ptr as *const i32, num_frames * channels as usize) };
        let floats: Vec<f32> = samples.iter().map(|&sample| sample as f32 / 2_147_483_648.0).collect();
        convert_and_downmix_to_stereo(
            floats.as_ptr() as *const u8,
            num_frames,
            channels,
            32,
            false,
            out_stereo,
        );
    } else if bits_per_sample == 24 && encoding == PcmEncoding::Integer {
        let bytes = unsafe { std::slice::from_raw_parts(data_ptr, num_frames * channels as usize * 3) };
        let floats: Vec<f32> = bytes.chunks_exact(3).map(|sample| {
            let packed = (sample[0] as i32) | ((sample[1] as i32) << 8) | ((sample[2] as i32) << 16);
            ((packed << 8) >> 8) as f32 / 8_388_608.0
        }).collect();
        convert_and_downmix_to_stereo(
            floats.as_ptr() as *const u8,
            num_frames,
            channels,
            32,
            false,
            out_stereo,
        );
    } else {
        convert_and_downmix_to_stereo(data_ptr, num_frames, channels, bits_per_sample, false, out_stereo);
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
    use windows::Win32::System::Threading::{CreateEventW, WaitForMultipleObjects};

    pub(crate) const AUDCLNT_STREAMFLAGS_EVENTCALLBACK: u32 = 0x00040000;
    pub(crate) const AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM: u32 = 0x80000000;
    pub(crate) const AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY: u32 = 0x08000000;

    pub(crate) struct EventHandleGuard(pub(crate) HANDLE);

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

    pub(crate) fn resolve_self_and_child_pids(sys: &sysinfo::System) -> Vec<u32> {
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
        self_pids
    }

    pub(crate) fn resolve_single_process_root(pid: u32, sys: &sysinfo::System) -> u32 {
        let mut curr = sysinfo::Pid::from_u32(pid);
        let start_name = sys.process(curr).map(|p| p.name().to_string_lossy().to_lowercase());

        while let Some(proc) = sys.process(curr) {
            if let Some(parent_pid) = proc.parent() {
                if let Some(parent_proc) = sys.process(parent_pid) {
                    let parent_name = parent_proc.name().to_string_lossy().to_lowercase();
                    if start_name.as_deref() == Some(&parent_name) {
                        curr = parent_pid;
                        continue;
                    }
                }
            }
            break;
        }

        curr.as_u32()
    }

    pub(crate) fn is_pid_or_ancestor_excluded(
        pid: u32,
        excluded_roots: &[u32],
        excluded_names: &[String],
        self_pids: &[u32],
        sys: &sysinfo::System,
    ) -> bool {
        if self_pids.contains(&pid) || excluded_roots.contains(&pid) {
            return true;
        }

        let mut curr = sysinfo::Pid::from_u32(pid);
        while let Some(proc) = sys.process(curr) {
            let p_name = proc.name().to_string_lossy().to_lowercase();
            if excluded_names.iter().any(|target| {
                let target_clean = target.trim_end_matches(".exe");
                let p_clean = p_name.trim_end_matches(".exe");
                p_clean.eq_ignore_ascii_case(target_clean) || p_name.contains(target) || target.contains(&p_name)
            }) {
                return true;
            }

            if let Some(parent_pid) = proc.parent() {
                let p_u32 = parent_pid.as_u32();
                if self_pids.contains(&p_u32) || excluded_roots.contains(&p_u32) {
                    return true;
                }
                curr = parent_pid;
            } else {
                break;
            }
        }

        false
    }

    pub(crate) fn discover_active_non_excluded_pids(
        excluded_roots: &[u32],
        excluded_names: &[String],
        self_pids: &[u32],
        sys: &mut sysinfo::System,
    ) -> Vec<u32> {
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let mut non_excluded: Vec<u32> = Vec::new();

        unsafe {
            if let Ok(enumerator) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                if let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
                    if let Ok(session_manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) {
                        if let Ok(session_enum) = session_manager.GetSessionEnumerator() {
                            if let Ok(count) = session_enum.GetCount() {
                                for i in 0..count {
                                    if let Ok(control) = session_enum.GetSession(i) {
                                        if let Ok(state) = control.GetState() {
                                            if state != AudioSessionStateActive {
                                                continue;
                                            }
                                        }

                                        if let Ok(control2) = control.cast::<IAudioSessionControl2>() {
                                            let s_pid = control2.GetProcessId().unwrap_or(0);
                                            if s_pid > 4 {
                                                if !is_pid_or_ancestor_excluded(s_pid, excluded_roots, excluded_names, self_pids, sys) {
                                                    let root = resolve_single_process_root(s_pid, sys);
                                                    if root > 4 && !non_excluded.contains(&root) {
                                                        non_excluded.push(root);
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
            }
        }

        non_excluded
    }

    pub(crate) fn resolve_target_process_roots(
        target_names: &[String],
        target_pids: &[u32],
    ) -> Vec<u32> {
        let mut sys = sysinfo::System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        let normalized_names: Vec<String> = target_names
            .iter()
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();

        let mut candidate_pids: Vec<u32> = Vec::new();
        for &pid in target_pids {
            if pid > 0 && sys.process(sysinfo::Pid::from_u32(pid)).is_some() {
                candidate_pids.push(pid);
            }
        }

        for (pid, proc) in sys.processes() {
            let p_name = proc.name().to_string_lossy().to_lowercase();
            if normalized_names.iter().any(|target| {
                let target_clean = target.trim_end_matches(".exe");
                let p_clean = p_name.trim_end_matches(".exe");
                p_clean == target_clean || p_name.contains(target) || target.contains(&p_name)
            }) {
                let u = pid.as_u32();
                if !candidate_pids.contains(&u) {
                    candidate_pids.push(u);
                }
            }
        }

        if candidate_pids.is_empty() {
            return Vec::new();
        }

        // A candidate PID is a top-level root candidate only if no other candidate PID is an ancestor of it.
        let mut top_level_candidates: Vec<u32> = Vec::new();
        for &pid in &candidate_pids {
            let mut curr = sysinfo::Pid::from_u32(pid);
            let mut has_candidate_ancestor = false;
            while let Some(proc) = sys.process(curr) {
                if let Some(parent_pid) = proc.parent() {
                    let parent_u32 = parent_pid.as_u32();
                    if candidate_pids.contains(&parent_u32) {
                        has_candidate_ancestor = true;
                        break;
                    }
                    curr = parent_pid;
                } else {
                    break;
                }
            }
            if !has_candidate_ancestor && !top_level_candidates.contains(&pid) {
                top_level_candidates.push(pid);
            }
        }

        let mut root_pids: Vec<u32> = Vec::new();
        for &start_pid in &top_level_candidates {
            let mut curr = sysinfo::Pid::from_u32(start_pid);
            let start_name = sys.process(curr).map(|p| p.name().to_string_lossy().to_lowercase());

            while let Some(proc) = sys.process(curr) {
                if let Some(parent_pid) = proc.parent() {
                    if let Some(parent_proc) = sys.process(parent_pid) {
                        let parent_name = parent_proc.name().to_string_lossy().to_lowercase();
                        if start_name.as_deref() == Some(&parent_name) {
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

        root_pids
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

    pub(crate) struct MultiCaptureSource {
        pub client: IAudioClient,
        pub capture: IAudioCaptureClient,
        pub event: HANDLE,
        pub _event_guard: EventHandleGuard,
        pub pid: u32,
        pub fifo: std::collections::VecDeque<f32>,
        pub last_packet_time: std::time::Instant,
    }

    pub(crate) fn init_capture_source(
        client: IAudioClient,
        stream_flags: u32,
        buffer_duration: i64,
        mix_format_ptr: *const WAVEFORMATEX,
        pid: u32,
    ) -> Result<MultiCaptureSource, String> {
        unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                stream_flags,
                buffer_duration,
                0,
                mix_format_ptr,
                None,
            ).map_err(|e| format!("Initialize failed for PID {}: {:?}", pid, e))?;

            let ev = CreateEventW(None, false, false, PCWSTR::null())
                .map_err(|e| format!("CreateEventW failed for PID {}: {:?}", pid, e))?;

            if let Err(e) = client.SetEventHandle(ev) {
                let _ = CloseHandle(ev);
                return Err(format!("SetEventHandle failed for PID {}: {:?}", pid, e));
            }

            let capture: IAudioCaptureClient = match client.GetService() {
                Ok(c) => c,
                Err(e) => {
                    let _ = CloseHandle(ev);
                    return Err(format!("GetService failed for PID {}: {:?}", pid, e));
                }
            };

            if let Err(e) = client.Start() {
                let _ = CloseHandle(ev);
                return Err(format!("Start failed for PID {}: {:?}", pid, e));
            }

            Ok(MultiCaptureSource {
                client,
                capture,
                event: ev,
                _event_guard: EventHandleGuard(ev),
                pid,
                fifo: std::collections::VecDeque::with_capacity(4096),
                last_packet_time: std::time::Instant::now(),
            })
        }
    }

    pub fn run_capture_loop(app: AppHandle, config: AudioConfig, stop_flag: Arc<AtomicBool>) {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let _ = windows::Win32::Media::timeBeginPeriod(1);
            struct TimePeriodGuard;
            impl Drop for TimePeriodGuard {
                fn drop(&mut self) {
                    unsafe {
                        let _ = windows::Win32::Media::timeEndPeriod(1);
                    }
                }
            }
            let _time_guard = TimePeriodGuard;

            let mut is_allocated_format = false;
            let mut mix_format_ptr: *mut WAVEFORMATEX = if let Ok(master_client) = get_default_render_audio_client() {
                master_client.GetMixFormat().unwrap_or(std::ptr::null_mut())
            } else {
                std::ptr::null_mut()
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
                crate::logger::log_msg("WARN", "audio.loopback", "Device mix format unavailable; fallback=48000Hz stereo");
                mix_format_ptr = &mut fallback_format as *mut _;
            } else {
                is_allocated_format = true;
            }

            let mix_format = &*mix_format_ptr;
            let sample_rate = mix_format.nSamplesPerSec;
            let channels = mix_format.nChannels;
            let bits_per_sample = mix_format.wBitsPerSample;
            let encoding = match mix_format.wFormatTag {
                1 => PcmEncoding::Integer,
                3 => PcmEncoding::Float32,
                0xfffe if mix_format.cbSize as usize >= std::mem::size_of::<WAVEFORMATEXTENSIBLE>() - std::mem::size_of::<WAVEFORMATEX>() => {
                    let extended = &*(mix_format_ptr as *const WAVEFORMATEXTENSIBLE);
                    let subtype = std::ptr::addr_of!(extended.SubFormat).read_unaligned();
                    if subtype == windows::core::GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71) {
                        PcmEncoding::Float32
                    } else if subtype == windows::core::GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71) {
                        PcmEncoding::Integer
                    } else {
                        crate::logger::log_msg("ERROR", "audio.loopback", "Unsupported extensible device mix subtype");
                        if is_allocated_format {
                            CoTaskMemFree(Some(mix_format_ptr as *const _));
                        }
                        CoUninitialize();
                        return;
                    }
                }
                tag => {
                    crate::logger::log_msg("ERROR", "audio.loopback", &format!("Unsupported device mix format tag={tag}; capture cannot decode audio safely"));
                    if is_allocated_format {
                        CoTaskMemFree(Some(mix_format_ptr as *const _));
                    }
                    CoUninitialize();
                    return;
                }
            };

            let stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK
                | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

            let buffer_duration = 10_000_000i64; // 1 second buffer in 100ns units

            let mut sys = sysinfo::System::new_all();
            sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            let self_pids = resolve_self_and_child_pids(&sys);

            let normalized_names: Vec<String> = config
                .target_names
                .iter()
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty())
                .collect();

            let mut multi_sources: Vec<MultiCaptureSource> = Vec::new();

            let excluded_roots = if config.mode == "exclude" {
                let roots = resolve_target_process_roots(&config.target_names, &config.target_pids);
                let specifies_self = normalized_names.iter().any(|t| t.contains("p2sharer"))
                    || config.target_pids.iter().any(|&p| self_pids.contains(&p))
                    || roots.iter().any(|&p| self_pids.contains(&p));

                let mut filtered_roots: Vec<u32> = roots
                    .into_iter()
                    .filter(|p| !self_pids.contains(p) && *p != std::process::id())
                    .collect();

                if specifies_self {
                    filtered_roots.push(std::process::id());
                }
                filtered_roots
            } else {
                Vec::new()
            };

            let is_multi_exclude = config.mode == "exclude" && excluded_roots.len() > 1;

            let is_multi_include = config.mode == "include" && {
                let roots = resolve_target_process_roots(&config.target_names, &config.target_pids);
                !roots.is_empty()
            };

            if config.mode == "full" {
                println!("[Audio Loopback] Mode: FULL. Activating master loopback.");
                if let Ok(master) = get_default_render_audio_client() {
                    if let Ok(src) = init_capture_source(master, stream_flags, buffer_duration, mix_format_ptr, 0) {
                        multi_sources.push(src);
                    }
                }
            } else if config.mode == "include" {
                let include_roots = resolve_target_process_roots(&config.target_names, &config.target_pids);
                println!(
                    "[Audio Loopback] Mode: INCLUDE. Resolved {} target root(s): {:?}",
                    include_roots.len(),
                    include_roots
                );
                if include_roots.is_empty() {
                    println!("[Audio Loopback] Mode: INCLUDE with 0 running targets; audio will be captured dynamically as targets start.");
                } else {
                    for &pid in &include_roots {
                        if let Ok(client) = activate_process_loopback_client(pid, false) {
                            if let Ok(src) = init_capture_source(client, stream_flags, buffer_duration, mix_format_ptr, pid) {
                                println!("[Audio Loopback] Include: Started loopback for PID {}", pid);
                                multi_sources.push(src);
                            }
                        }
                    }
                }
            } else {
                // config.mode == "exclude"
                println!(
                    "[Audio Loopback] Mode: EXCLUDE. Resolved {} excluded root(s): {:?}",
                    excluded_roots.len(),
                    excluded_roots
                );
                if excluded_roots.is_empty() {
                    println!("[Audio Loopback] Exclude mode with 0 targets; capturing all audio via master loopback.");
                    if let Ok(master) = get_default_render_audio_client() {
                        if let Ok(src) = init_capture_source(master, stream_flags, buffer_duration, mix_format_ptr, 0) {
                            multi_sources.push(src);
                        }
                    }
                } else if excluded_roots.len() == 1 {
                    let single_pid = excluded_roots[0];
                    println!(
                        "[Audio Loopback] Exclude mode with 1 target (PID {}). Activating native WASAPI exclude loopback.",
                        single_pid
                    );
                    let mut activated = false;
                    if let Ok(client) = activate_process_loopback_client(single_pid, true) {
                        if let Ok(src) = init_capture_source(client, stream_flags, buffer_duration, mix_format_ptr, single_pid) {
                            multi_sources.push(src);
                            activated = true;
                        }
                    }
                    if !activated {
                        crate::logger::log_msg("WARN", "audio.loopback", "Process exclusion capture failed; fallback=master loopback");
                        if let Ok(master) = get_default_render_audio_client() {
                            if let Ok(src) = init_capture_source(master, stream_flags, buffer_duration, mix_format_ptr, 0) {
                                multi_sources.push(src);
                            }
                        }
                    }
                } else {
                    println!(
                        "[Audio Loopback] Multi-exclude mode active for {} apps. Using dynamic session inversion.",
                        excluded_roots.len()
                    );
                    let initial_pids = discover_active_non_excluded_pids(&excluded_roots, &normalized_names, &self_pids, &mut sys);
                    println!(
                        "[Audio Loopback] Discovered {} non-excluded active audio sessions to capture: {:?}",
                        initial_pids.len(),
                        initial_pids
                    );
                    for &pid in &initial_pids {
                        if let Ok(client) = activate_process_loopback_client(pid, false) {
                            if let Ok(src) = init_capture_source(client, stream_flags, buffer_duration, mix_format_ptr, pid) {
                                println!("[Audio Loopback] Multi-exclude: Capturing non-excluded session PID {}", pid);
                                multi_sources.push(src);
                            }
                        }
                    }
                }
            }

            println!(
                "[Audio Loopback] Initialized with {} active capture client(s) ({} Hz, {} ch, bits: {})",
                multi_sources.len(),
                sample_rate,
                channels,
                bits_per_sample
            );

            let stream_start = std::time::Instant::now();
            let mut resampler = AudioResampler::new(sample_rate, 48000);
            let mut raw_stereo_buffer: Vec<f32> = Vec::with_capacity(4096);
            let mut standardized_buffer: Vec<f32> = Vec::with_capacity(4096);

            let (session_tx, session_rx) = std::sync::mpsc::sync_channel(1);
            if is_multi_exclude || is_multi_include {
                let worker_stop = stop_flag.clone();
                let worker_excluded_roots = excluded_roots.clone();
                let worker_names = normalized_names.clone();
                let worker_self_pids = self_pids.clone();
                let worker_targets = config.target_names.clone();
                let worker_target_pids = config.target_pids.clone();
                std::thread::spawn(move || {
                    let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
                    let mut worker_sys = sysinfo::System::new_all();
                    while worker_stop.load(Ordering::Relaxed) {
                        let active = if is_multi_exclude {
                            discover_active_non_excluded_pids(
                                &worker_excluded_roots, &worker_names, &worker_self_pids, &mut worker_sys,
                            )
                        } else {
                            resolve_target_process_roots(&worker_targets, &worker_target_pids)
                        };
                        worker_sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
                        let live: Vec<u32> = worker_sys.processes().keys().map(|pid| pid.as_u32()).collect();
                        let _ = session_tx.try_send((active, live));
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                    if initialized {
                        CoUninitialize();
                    }
                });
            }

            while stop_flag.load(Ordering::Relaxed) {
                if let Ok((active_pids, live_pids)) = session_rx.try_recv() {
                    multi_sources.retain(|s| s.pid == 0 || live_pids.contains(&s.pid));
                    for pid in active_pids {
                        if !multi_sources.iter().any(|s| s.pid == pid) && multi_sources.len() < 64 {
                            if let Ok(client) = activate_process_loopback_client(pid, false) {
                                if let Ok(src) = init_capture_source(client, stream_flags, buffer_duration, mix_format_ptr, pid) {
                                    println!("[Audio Loopback] Dynamically captured audio session PID {}", pid);
                                    multi_sources.push(src);
                                }
                            }
                        }
                    }
                }

                if multi_sources.is_empty() {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    continue;
                }

                let events: Vec<HANDLE> = multi_sources.iter().map(|s| s.event).collect();
                let wait_len = events.len().min(64);
                let wait_handles = &events[..wait_len];

                let wait_res = WaitForMultipleObjects(wait_handles, false, 5);

                if (wait_res.0 >= WAIT_OBJECT_0.0 && wait_res.0 < WAIT_OBJECT_0.0 + wait_len as u32) || wait_res == WAIT_TIMEOUT {
                    for source in &mut multi_sources {
                        let mut packet_size = source.capture.GetNextPacketSize().unwrap_or(0);
                        while packet_size > 0 {
                            let mut data_ptr: *mut u8 = null_mut();
                            let mut num_frames_read = 0u32;
                            let mut flags = 0u32;
                            let mut qpc_pos = 0u64;

                            let get_res = source.capture.GetBuffer(
                                &mut data_ptr,
                                &mut num_frames_read,
                                &mut flags,
                                None,
                                Some(&mut qpc_pos),
                            );

                            if get_res.is_ok() && num_frames_read > 0 && !data_ptr.is_null() {
                                source.last_packet_time = std::time::Instant::now();
                                let is_silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                                let mut packet_stereo = Vec::new();
                                convert_and_downmix_encoded(
                                    data_ptr,
                                    num_frames_read as usize,
                                    channels,
                                    bits_per_sample,
                                    encoding,
                                    is_silent,
                                    &mut packet_stereo,
                                );
                                source.fifo.extend(packet_stereo);
                                let _ = source.capture.ReleaseBuffer(num_frames_read);
                            } else if get_res.is_ok() && num_frames_read > 0 {
                                let _ = source.capture.ReleaseBuffer(num_frames_read);
                            }

                            packet_size = source.capture.GetNextPacketSize().unwrap_or(0);
                        }

                        // Allow a short OS scheduling pause without deleting valid samples.
                        const MAX_FIFO_SAMPLES: usize = 19200;
                        if source.fifo.len() > MAX_FIFO_SAMPLES {
                            let excess = source.fifo.len() - MAX_FIFO_SAMPLES;
                            let excess_even = (excess / 2) * 2;
                            source.fifo.drain(..excess_even);
                        }
                    }

                    if multi_sources.len() == 1 {
                        // WASAPI packets carry the device's sample clock. Re-timing them with
                        // a second wall clock periodically underflows and inserts hard zeros.
                        let source = &mut multi_sources[0];
                        drain_single_source_samples(
                            &mut source.fifo,
                            sample_rate,
                            &mut resampler,
                            &mut raw_stereo_buffer,
                            &mut standardized_buffer,
                        );
                    } else {
                        let tick_frames = ((sample_rate as u64 * 10) / 1000) as usize;
                        let tick_floats = tick_frames * 2;
                        let stale = multi_sources.iter().all(|s| {
                            s.last_packet_time.elapsed() >= std::time::Duration::from_millis(50)
                        });
                        // The fullest capture FIFO supplies the pacing clock. Keep one
                        // chunk in reserve while active so event order cannot create
                        // hard zero-filled underruns in the mixed PCM.
                        loop {
                            let available = multi_sources.iter().map(|s| s.fifo.len()).max().unwrap_or(0);
                            if available < tick_floats * 2 && !(stale && available > 0) {
                                break;
                            }
                            let mut fifos: Vec<_> = multi_sources.iter_mut().map(|s| &mut s.fifo).collect();
                            mix_one_chunk(&mut fifos, tick_frames, &mut raw_stereo_buffer);
                            if stale && available < tick_floats {
                                let actual_frames = available / 2;
                                let fade_frames = actual_frames.min(240);
                                for frame in 0..fade_frames {
                                    let index = (actual_frames - fade_frames + frame) * 2;
                                    let gain = 0.5 * (1.0 + (std::f32::consts::PI * frame as f32 / fade_frames as f32).cos());
                                    raw_stereo_buffer[index] *= gain;
                                    raw_stereo_buffer[index + 1] *= gain;
                                }
                            }
                            if sample_rate != 48000 {
                                resampler.resample(&raw_stereo_buffer, &mut standardized_buffer);
                            } else {
                                standardized_buffer.extend_from_slice(&raw_stereo_buffer);
                            }
                            raw_stereo_buffer.clear();
                        }
                    }
                } else {
                    break;
                }

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

                // If all sources have been quiet for at least 50ms and residual samples (< 960) remain,
                // smoothly fade-out using a Hann half-cosine window (240 samples = 5ms) and flush to prevent tail-end clicks ("mini chiado").
                if !standardized_buffer.is_empty()
                    && multi_sources.iter().all(|s| s.last_packet_time.elapsed() >= std::time::Duration::from_millis(50))
                {
                    let rem = standardized_buffer.len();
                    let fade_len = rem.min(240);
                    let start_idx = rem - fade_len;
                    for i in 0..fade_len {
                        let phase = std::f32::consts::PI * (i as f32 / fade_len as f32);
                        let factor = 0.5 * (1.0 + phase.cos());
                        standardized_buffer[start_idx + i] *= factor;
                    }
                    standardized_buffer.resize(min_samples, 0.0f32);

                    let mut sum_sq = 0.0f32;
                    for &s in &standardized_buffer[..min_samples] {
                        sum_sq += s * s;
                    }
                    let rms = (sum_sq / min_samples as f32).sqrt().min(1.0);

                    let mut byte_vec = vec![0u8; min_samples * 4];
                    LittleEndian::write_f32_into(&standardized_buffer[..min_samples], &mut byte_vec);

                    let timestamp_us = stream_start.elapsed().as_micros() as u64;

                    let payload = AudioStreamPayload {
                        pcm_base64: BASE64.encode(&byte_vec),
                        sample_rate: 48000,
                        channels: 2,
                        rms_level: rms,
                        timestamp_us,
                    };

                    let _ = app.emit("p2sharer://audio-stream", payload);

                    standardized_buffer.clear();
                }
            }

            for source in multi_sources {
                let _ = source.client.Stop();
            }

            if is_allocated_format {
                CoTaskMemFree(Some(mix_format_ptr as *const _));
            }
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

pub fn is_audio_capturing() -> bool {
    if let Ok(guard) = CURRENT_STOP_FLAG.lock() {
        if let Some(flag) = guard.as_ref() {
            return flag.load(Ordering::Relaxed);
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn production_event_guard_closes_on_scope_exit_and_unwind() {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::GetHandleInformation;
        use windows::Win32::System::Threading::CreateEventW;
        for unwind in [false, true] {
            let handle = unsafe { CreateEventW(None, false, false, PCWSTR::null()) }.unwrap();
            let mut flags = 0;
            assert!(unsafe { GetHandleInformation(handle, &mut flags) }.is_ok());
            let guard = win_audio::EventHandleGuard(handle);
            let result = std::panic::catch_unwind(move || {
                let _guard = guard;
                if unwind { panic!("fixture unwind"); }
            });
            assert_eq!(result.is_err(), unwind);
            assert!(unsafe { GetHandleInformation(handle, &mut flags) }.is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires a default Windows audio output device"]
    fn test_default_render_mix_format_is_decodable() {
        unsafe {
            use windows::Win32::Media::Audio::WAVEFORMATEXTENSIBLE;
            use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED};
            let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            let client = win_audio::get_default_render_audio_client().expect("default render device");
            let format_ptr = client.GetMixFormat().expect("device mix format");
            let format = &*format_ptr;
            let rate = format.nSamplesPerSec;
            let channels = format.nChannels;
            let bits = format.wBitsPerSample;
            let tag = format.wFormatTag;
            println!("Default audio mix: {} Hz, {} channels, {} bits, tag 0x{:04x}",
                rate, channels, bits, tag);
            assert!(matches!(bits, 16 | 24 | 32));
            assert!(matches!(tag, 1 | 3 | 0xfffe));
            if tag == 0xfffe {
                let extended = &*(format_ptr as *const WAVEFORMATEXTENSIBLE);
                let subtype = std::ptr::addr_of!(extended.SubFormat).read_unaligned();
                assert!(subtype == windows::core::GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71)
                    || subtype == windows::core::GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71));
            }
            CoTaskMemFree(Some(format_ptr as *const _));
            if initialized { CoUninitialize(); }
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "plays a quiet test tone through the default output device"]
    fn test_live_default_loopback_tone_continuity() {
        unsafe {
            use windows::Win32::Media::Audio::*;
            use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED};
            use windows::Win32::System::Threading::WaitForSingleObject;

            let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            let render = win_audio::get_default_render_audio_client().expect("default render client");
            let format_ptr = render.GetMixFormat().expect("mix format");
            let format = &*format_ptr;
            let rate = format.nSamplesPerSec;
            let channels = format.nChannels;
            let bits = format.wBitsPerSample;
            assert_eq!(bits, 32, "live fixture expects 32-bit device mix");
            let subtype = if format.wFormatTag == 0xfffe {
                let extended = &*(format_ptr as *const WAVEFORMATEXTENSIBLE);
                std::ptr::addr_of!(extended.SubFormat).read_unaligned()
            } else {
                windows::core::GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71)
            };
            assert_eq!(subtype, windows::core::GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71));

            render.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 10_000_000, 0, format_ptr, None)
                .expect("render initialization");
            let render_service: IAudioRenderClient = render.GetService().expect("render service");
            let frame_count = render.GetBufferSize().expect("render buffer size");
            let capture_client = win_audio::get_default_render_audio_client()
                .expect("default loopback");
            let flags = AUDCLNT_STREAMFLAGS_LOOPBACK | win_audio::AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                | win_audio::AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | win_audio::AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
            let source = win_audio::init_capture_source(capture_client, flags, 10_000_000, format_ptr, std::process::id())
                .expect("capture initialization");

            let samples = render_service.GetBuffer(frame_count).expect("render buffer") as *mut f32;
            for frame in 0..frame_count as usize {
                let tone = (2.0 * std::f64::consts::PI * 997.0 * frame as f64 / rate as f64).sin() as f32 * 0.02;
                for channel in 0..channels as usize {
                    *samples.add(frame * channels as usize + channel) = tone;
                }
            }
            render_service.ReleaseBuffer(frame_count, 0).expect("release render buffer");
            render.Start().expect("start test tone");

            let start = std::time::Instant::now();
            let mut captured = Vec::new();
            while start.elapsed() < std::time::Duration::from_millis(850) {
                let _ = WaitForSingleObject(source.event, 20);
                let mut pending = source.capture.GetNextPacketSize().unwrap_or(0);
                while pending > 0 {
                    let mut data = std::ptr::null_mut();
                    let mut frames = 0;
                    let mut packet_flags = 0;
                    if source.capture.GetBuffer(&mut data, &mut frames, &mut packet_flags, None, None).is_ok() {
                        convert_and_downmix_encoded(data, frames as usize, channels, 32, PcmEncoding::Float32,
                            packet_flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0, &mut captured);
                        source.capture.ReleaseBuffer(frames).expect("release capture buffer");
                    }
                    pending = source.capture.GetNextPacketSize().unwrap_or(0);
                }
            }
            render.Stop().expect("stop tone");
            source.client.Stop().expect("stop capture");
            CoTaskMemFree(Some(format_ptr as *const _));
            if initialized { CoUninitialize(); }

            let ten_ms = rate as usize / 100 * 2;
            let rms: Vec<f32> = captured.chunks_exact(ten_ms).map(|block| {
                (block.iter().map(|sample| sample * sample).sum::<f32>() / block.len() as f32).sqrt()
            }).collect();
            let good_blocks = rms.iter().skip(3).take(rms.len().saturating_sub(6)).filter(|&&level| level > 0.003).count();
            println!("Captured {} frames, {} / {} steady 10ms blocks contain tone", captured.len() / 2, good_blocks, rms.len());
            assert!(rms.len() >= 70, "too few real WASAPI packets captured");
            assert!(good_blocks >= rms.len().saturating_sub(8), "real capture has silent dropouts");
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires Windows process loopback support and an audio output device"]
    fn test_process_loopback_activation_and_init() {
        unsafe {
            use windows::core::PCWSTR;
            use windows::Win32::Foundation::CloseHandle;
            use windows::Win32::Media::Audio::*;
            use windows::Win32::System::Com::*;
            use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

            CoInitializeEx(None, COINIT_MULTITHREADED).ok().expect("test COM initialization");
            let my_pid = std::process::id();
            let client_res = win_audio::activate_process_loopback_client(my_pid, true);
            assert!(client_res.is_ok(), "Process loopback activation must succeed for valid PID");

            if let Ok(client) = client_res {
                let master_client = win_audio::get_default_render_audio_client().expect("default render device");
                {
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
                    let client2 = win_audio::activate_process_loopback_client(my_pid, true).expect("second process loopback client");
                    {
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
                    CoTaskMemFree(Some(mix_format as *const _));
                }
            }
            CoUninitialize();
        }
    }

    #[cfg(windows)]
    #[test]
    fn test_wait_for_multiple_objects_and_roots() {
        unsafe {
            use windows::core::PCWSTR;
            use windows::Win32::Foundation::CloseHandle;
            use windows::Win32::System::Threading::{CreateEventW, WaitForMultipleObjects};

            let ev1 = CreateEventW(None, false, false, PCWSTR::null()).unwrap();
            let ev2 = CreateEventW(None, false, false, PCWSTR::null()).unwrap();
            let handles = [ev1, ev2];
            let res = WaitForMultipleObjects(&handles, false, 0);
            let _ = CloseHandle(ev1);
            let _ = CloseHandle(ev2);
            assert_eq!(res, windows::Win32::Foundation::WAIT_TIMEOUT);
        }

        let my_pid = std::process::id();
        let roots = win_audio::resolve_target_process_roots(&[], &[my_pid]);
        assert!(!roots.is_empty(), "Should resolve root for current process");
    }

    #[cfg(windows)]
    #[test]
    fn test_multi_process_exclusion_filtering() {
        let my_pid = std::process::id();
        let roots = win_audio::resolve_target_process_roots(&["p2sharer".to_string()], &[my_pid]);
        assert!(!roots.is_empty(), "Should resolve roots for target");

        let mut sys = sysinfo::System::new_all();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let self_pids = win_audio::resolve_self_and_child_pids(&sys);
        assert!(self_pids.contains(&my_pid), "Self PIDs must contain current PID");

        let is_self_excluded = win_audio::is_pid_or_ancestor_excluded(
            my_pid,
            &roots,
            &["p2sharer.exe".to_string(), "discord.exe".to_string(), "firefox.exe".to_string()],
            &self_pids,
            &sys,
        );
        assert!(is_self_excluded, "Self process must be identified as excluded");

        let is_dummy_excluded = win_audio::is_pid_or_ancestor_excluded(
            999_999,
            &roots,
            &["p2sharer.exe".to_string(), "discord.exe".to_string(), "firefox.exe".to_string()],
            &self_pids,
            &sys,
        );
        assert!(!is_dummy_excluded, "Unknown non-excluded PID must not be identified as excluded");
    }

    #[test]
    fn test_soft_clip_sample_linearity_and_saturation() {
        // Linearity test for normal broadcast range (-0.8 to 0.8)
        assert_eq!(soft_clip_sample(0.0), 0.0);
        assert_eq!(soft_clip_sample(0.5), 0.5);
        assert_eq!(soft_clip_sample(-0.5), -0.5);
        assert_eq!(soft_clip_sample(0.8), 0.8);
        assert_eq!(soft_clip_sample(-0.8), -0.8);

        // Saturation test above 0.8: must be strictly < 1.0 and monotonic
        let s09 = soft_clip_sample(0.9);
        let s12 = soft_clip_sample(1.2);
        let s20 = soft_clip_sample(2.0);
        let s50 = soft_clip_sample(5.0);

        assert!(s09 > 0.8 && s09 < 1.0);
        assert!(s12 > s09 && s12 < 1.0);
        assert!(s20 > s12 && s20 < 1.0);
        assert!(s50 >= s20 && s50 < 1.0);

        // Negative symmetry
        assert_eq!(soft_clip_sample(-0.9), -s09);
        assert_eq!(soft_clip_sample(-2.0), -s20);
    }
}

