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
}

static CURRENT_STOP_FLAG: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

#[cfg(windows)]
mod win_audio {
    use super::*;
    use std::ptr::null_mut;
    use windows::core::{Interface, HRESULT, PCWSTR};
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;

    const AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM: u32 = 0x80000000;
    const AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY: u32 = 0x08000000;

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

    fn resolve_target_process_tree(target_names: &[String], target_pids: &[u32]) -> u32 {
        let mut sys = sysinfo::System::new_all();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        let normalized_names: Vec<String> = target_names.iter().map(|n| n.to_lowercase()).collect();

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

        root_pids[0]
    }

    fn activate_process_loopback_client(pid: u32, exclude: bool) -> Result<IAudioClient, String> {
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

            // Special Case: In "include" mode with 0 apps selected, stream absolute silence
            if config.mode == "include" && config.target_pids.is_empty() && config.target_names.is_empty() {
                println!("[Audio Loopback] Include mode active with 0 apps selected - streaming silence.");
                while stop_flag.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                let _ = CoUninitialize();
                return;
            }

            // Determine activation method based on PID / Name and mode
            let target_pid = resolve_target_process_tree(&config.target_names, &config.target_pids);
            let is_process_mode = target_pid > 0 && (config.mode == "exclude" || config.mode == "include");

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
                                let _ = CoUninitialize();
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
                        let _ = CoUninitialize();
                        return;
                    }
                }
            };

            // Query mix format from default render device (process loopback doesn't implement GetMixFormat directly)
            let mix_format_ptr: *mut WAVEFORMATEX = if let Ok(master_client) = get_default_render_audio_client() {
                master_client.GetMixFormat().unwrap_or_else(|_| std::ptr::null_mut())
            } else {
                audio_client.GetMixFormat().unwrap_or_else(|_| std::ptr::null_mut())
            };

            if mix_format_ptr.is_null() {
                eprintln!("[Audio Loopback] Failed to retrieve valid mix format.");
                let _ = CoUninitialize();
                return;
            }

            let mix_format = &*mix_format_ptr;
            let sample_rate = mix_format.nSamplesPerSec;
            let channels = mix_format.nChannels;
            let bits_per_sample = mix_format.wBitsPerSample;

            let stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

            let buffer_duration = 10_000_000i64; // 1 second buffer in 100ns units

            if let Err(err) = audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                stream_flags,
                buffer_duration,
                0,
                mix_format_ptr,
                None,
            ) {
                eprintln!("[Audio Loopback] Failed to initialize audio client (was_process={}): {:?}", was_process_loopback, err);
                CoTaskMemFree(Some(mix_format_ptr as *const _));
                let _ = CoUninitialize();
                return;
            }

            CoTaskMemFree(Some(mix_format_ptr as *const _));

            let capture_client: IAudioCaptureClient = match audio_client.GetService() {
                Ok(c) => c,
                Err(err) => {
                    eprintln!("[Audio Loopback] Failed to get capture client: {:?}", err);
                    let _ = CoUninitialize();
                    return;
                }
            };

            if let Err(err) = audio_client.Start() {
                eprintln!("[Audio Loopback] Failed to start audio client: {:?}", err);
                let _ = CoUninitialize();
                return;
            }

            println!(
                "[Audio Loopback] Windows WASAPI loopback capture active ({} Hz, {} channels, ProcessFilter: {})",
                sample_rate, channels, was_process_loopback
            );

            let mut send_buffer: Vec<f32> = Vec::with_capacity(2048);

            while stop_flag.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(5));

                let mut packet_size = match capture_client.GetNextPacketSize() {
                    Ok(s) => s,
                    Err(_) => break,
                };

                while packet_size > 0 {
                    let mut data_ptr: *mut u8 = null_mut();
                    let mut num_frames_read = 0u32;
                    let mut flags = 0u32;

                    if capture_client
                        .GetBuffer(
                            &mut data_ptr,
                            &mut num_frames_read,
                            &mut flags,
                            None,
                            None,
                        )
                        .is_ok()
                    {
                        if num_frames_read > 0 && !data_ptr.is_null() {
                            let is_silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                            let total_samples = (num_frames_read * channels as u32) as usize;

                            if is_silent {
                                send_buffer.extend(std::iter::repeat(0.0f32).take(total_samples));
                            } else if bits_per_sample == 32 {
                                let float_slice =
                                    std::slice::from_raw_parts(data_ptr as *const f32, total_samples);
                                send_buffer.extend_from_slice(float_slice);
                            } else if bits_per_sample == 16 {
                                let int_slice =
                                    std::slice::from_raw_parts(data_ptr as *const i16, total_samples);
                                for &sample in int_slice {
                                    send_buffer.push(sample as f32 / 32768.0);
                                }
                            }
                        }
                        let _ = capture_client.ReleaseBuffer(num_frames_read);
                    }

                    packet_size = capture_client.GetNextPacketSize().unwrap_or(0);
                }

                // Emit chunk every ~10ms for minimal latency (Discord / TeamSpeak level)
                let min_samples_to_send = (sample_rate as usize * channels as usize) / 100;
                if send_buffer.len() >= min_samples_to_send {
                    let mut sum_sq = 0.0f32;
                    for &s in &send_buffer {
                        sum_sq += s * s;
                    }
                    let rms = (sum_sq / send_buffer.len() as f32).sqrt();

                    let mut byte_vec = vec![0u8; send_buffer.len() * 4];
                    LittleEndian::write_f32_into(&send_buffer, &mut byte_vec);

                    let payload = AudioStreamPayload {
                        pcm_base64: BASE64.encode(&byte_vec),
                        sample_rate,
                        channels,
                        rms_level: rms.min(1.0),
                    };

                    let _ = app.emit("p2sharer://audio-stream", payload);
                    send_buffer.clear();
                }
            }

            let _ = audio_client.Stop();
            let _ = CoUninitialize();
            println!("[Audio Loopback] Audio loopback stopped cleanly.");
        }
    }

    fn get_default_render_audio_client() -> Result<IAudioClient, windows::core::Error> {
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
