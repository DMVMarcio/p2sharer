use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use byteorder::{ByteOrder, LittleEndian};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AudioConfig {
    pub mode: String, // "full", "exclude", "include"
    pub target_pids: Vec<u32>,
    pub sample_rate: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AudioStreamPayload {
    pub pcm_base64: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub rms_level: f32,
}

static CAPTURING: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
mod win_audio {
    use super::*;
    use std::ptr::null_mut;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;

    const AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM: u32 = 0x80000000;
    const AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY: u32 = 0x08000000;

    pub fn run_capture_loop(app: AppHandle, _config: AudioConfig, stop_flag: Arc<AtomicBool>) {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

            let enumerator: Result<IMMDeviceEnumerator, _> =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL);

            let enumerator = match enumerator {
                Ok(e) => e,
                Err(err) => {
                    eprintln!("Failed to create MMDeviceEnumerator: {:?}", err);
                    let _ = CoUninitialize();
                    return;
                }
            };

            let device = match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
                Ok(d) => d,
                Err(err) => {
                    eprintln!("Failed to get default audio endpoint: {:?}", err);
                    let _ = CoUninitialize();
                    return;
                }
            };

            let audio_client: IAudioClient = match device.Activate(CLSCTX_ALL, None) {
                Ok(c) => c,
                Err(err) => {
                    eprintln!("Failed to activate IAudioClient: {:?}", err);
                    let _ = CoUninitialize();
                    return;
                }
            };

            let mix_format_ptr: *mut WAVEFORMATEX = match audio_client.GetMixFormat() {
                Ok(ptr) => ptr,
                Err(err) => {
                    eprintln!("Failed to get mix format: {:?}", err);
                    let _ = CoUninitialize();
                    return;
                }
            };

            let mix_format = &*mix_format_ptr;
            let sample_rate = mix_format.nSamplesPerSec;
            let channels = mix_format.nChannels;
            let bits_per_sample = mix_format.wBitsPerSample;

            // Stream flags: Loopback mode + auto convert
            let stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

            // 100ms buffer in 100ns units
            let buffer_duration = 1_000_000i64;

            if let Err(err) = audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                stream_flags,
                buffer_duration,
                0,
                mix_format_ptr,
                None,
            ) {
                eprintln!("Failed to initialize audio client: {:?}", err);
                CoTaskMemFree(Some(mix_format_ptr as *const _));
                let _ = CoUninitialize();
                return;
            }

            CoTaskMemFree(Some(mix_format_ptr as *const _));

            let capture_client: IAudioCaptureClient = match audio_client.GetService() {
                Ok(c) => c,
                Err(err) => {
                    eprintln!("Failed to get capture client: {:?}", err);
                    let _ = CoUninitialize();
                    return;
                }
            };

            if let Err(err) = audio_client.Start() {
                eprintln!("Failed to start audio client: {:?}", err);
                let _ = CoUninitialize();
                return;
            }

            let mut send_buffer: Vec<f32> = Vec::with_capacity(4096);

            while stop_flag.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(15));

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

                // If we accumulated ~20ms of audio, emit to frontend
                let min_samples_to_send = (sample_rate as usize * channels as usize) / 50;
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
        }
    }
}

#[tauri::command]
pub async fn start_audio_capture(app: AppHandle, config: AudioConfig) -> Result<bool, String> {
    if CAPTURING.load(Ordering::SeqCst) {
        return Ok(true);
    }

    CAPTURING.store(true, Ordering::SeqCst);
    let stop_flag = Arc::new(AtomicBool::new(true));
    let stop_clone = stop_flag.clone();

    std::thread::spawn(move || {
        #[cfg(windows)]
        win_audio::run_capture_loop(app, config, stop_clone);
    });

    Ok(true)
}

#[tauri::command]
pub fn stop_audio_capture() -> Result<bool, String> {
    CAPTURING.store(false, Ordering::SeqCst);
    Ok(true)
}
