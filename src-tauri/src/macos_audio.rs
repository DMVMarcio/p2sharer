//! ScreenCaptureKit system audio feeds the existing stereo PCM event bridge.
use crate::audio_loopback::{AudioConfig, AudioStreamPayload};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{ffi::{c_char, c_void, CStr, CString}, sync::{atomic::{AtomicBool, Ordering}, Arc}};
use tauri::{AppHandle, Emitter};

extern "C" {
    fn p2_screen_capture_allowed() -> bool;
    fn p2_audio_start(config: *const c_char, context: *mut c_void,
        callback: extern "C" fn(*mut c_void, *const f32, usize), error: *mut c_char, capacity: usize) -> *mut c_void;
    fn p2_audio_failed(handle: *mut c_void) -> bool;
    fn p2_audio_stop(handle: *mut c_void);
}

pub fn screen_capture_allowed() -> bool { unsafe { p2_screen_capture_allowed() } }

struct AudioContext { app: AppHandle, active: Arc<AtomicBool>, frames: u64 }
extern "C" fn deliver(context: *mut c_void, samples: *const f32, count: usize) {
    // The serial native queue owns this borrow until stop drains that queue.
    let context = unsafe { &mut *(context as *mut AudioContext) };
    if !context.active.load(Ordering::Relaxed) || count == 0 { return; }
    let samples = unsafe { std::slice::from_raw_parts(samples, count) };
    let payload = pcm_payload(samples, context.frames);
    context.frames += (count / 2) as u64;
    let _ = context.app.emit("p2sharer://audio-stream", payload);
}

fn pcm_payload(samples: &[f32], frames: u64) -> AudioStreamPayload {
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    let mut energy = 0.0;
    for &sample in samples {
        let sample = if sample.is_finite() { sample.clamp(-1.0, 1.0) } else { 0.0 };
        bytes.extend_from_slice(&sample.to_le_bytes());
        energy += sample * sample;
    }
    AudioStreamPayload { pcm_base64: STANDARD.encode(bytes), sample_rate: 48000,
        channels: 2, rms_level: if samples.is_empty() { 0.0 } else { (energy / samples.len() as f32).sqrt() },
        timestamp_us: frames * 1_000_000 / 48000 }
}

pub async fn start(app: AppHandle, config: AudioConfig, active: Arc<AtomicBool>) -> Result<bool, String> {
    let json = CString::new(serde_json::to_string(&config).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    let (ready, receive) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut context = Box::new(AudioContext { app, active: active.clone(), frames: 0 });
        let mut error = [0 as c_char; 1024];
        let handle = unsafe { p2_audio_start(json.as_ptr(), (&mut *context as *mut AudioContext).cast(), deliver, error.as_mut_ptr(), error.len()) };
        if handle.is_null() {
            active.store(false, Ordering::SeqCst);
            let message = unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy().into_owned();
            let _ = ready.send(Err(message));
            return;
        }
        let _ = ready.send(Ok(true));
        while active.load(Ordering::Relaxed) && !unsafe { p2_audio_failed(handle) } {
            // PCM delivery is event-driven; only the cancellation watchdog waits.
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        unsafe { p2_audio_stop(handle); }
        active.store(false, Ordering::SeqCst);
    });
    tauri::async_runtime::spawn_blocking(move || receive.recv().map_err(|error| error.to_string())?)
        .await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn screen_capture_pcm_matches_the_web_audio_bridge_contract() {
        let payload = pcm_payload(&[0.5, -0.5, f32::NAN, f32::INFINITY, 2.0, -2.0], 480);
        let bytes = STANDARD.decode(payload.pcm_base64).unwrap();
        let decoded: Vec<f32> = bytes.chunks_exact(4).map(|sample| f32::from_le_bytes(sample.try_into().unwrap())).collect();
        assert_eq!(decoded, [0.5, -0.5, 0.0, 0.0, 1.0, -1.0]);
        assert_eq!((payload.sample_rate, payload.channels, payload.timestamp_us), (48000, 2, 10000));
        assert!(payload.rms_level.is_finite() && payload.rms_level > 0.0 && payload.rms_level <= 1.0);
        assert_eq!(pcm_payload(&[], 0).rms_level, 0.0);
    }
}
