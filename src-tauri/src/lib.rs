pub mod audio_loopback;
pub mod logger;
pub mod pip_manager;
pub mod process_manager;
pub mod room_vault;
pub mod screen_sources;

use audio_loopback::{start_audio_capture, stop_audio_capture};
use logger::{clear_log_file, get_log_file_path, open_latest_log, open_log_folder, write_frontend_log};
use pip_manager::{close_pip_window, open_pip_window, set_pip_always_on_top};
use process_manager::{
    list_audio_processes, setup_job_object_for_clean_child_teardown,
};
use room_vault::{delete_room_record, list_room_records, save_room_record};
use screen_sources::{
    ensure_ws_server_running, get_video_ws_port, get_video_ws_token, list_screen_sources, start_native_screen_capture,
    stop_native_screen_capture,
};

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Bind process to Windows Job Object to guarantee atomic child teardown on exit.
    setup_job_object_for_clean_child_teardown();

    #[cfg(windows)]
    {
        // Enable GPU hardware rasterization, zero-copy video pipeline, WebCodecs & WebRTC HW acceleration in WebView2
        let current_args = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if !current_args.contains("--enable-blink-features=MediaStreamTrackGenerator") {
            let extra_args = "--enable-gpu-rasterization --enable-zero-copy --enable-accelerated-video-decode --enable-accelerated-video-encode --enable-webrtc-hw-h264-encoding --enable-webrtc-hw-vp8-encoding --enable-gpu-memory-buffer-video-frames --enable-features=WebRtcHardwareVideoEncoding,WebRtcHardwareVideoDecoding,AcceleratedVideoEncoder,AcceleratedVideoDecoder,MediaStreamTrackGenerator --enable-blink-features=MediaStreamTrackGenerator";
            let new_args = if current_args.is_empty() {
                extra_args.to_string()
            } else {
                format!("{} {}", current_args, extra_args)
            };
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", new_args);
        }
    }

    logger::init_logger();
    ensure_ws_server_running();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let label = window.label();
                if label == "main" {
                    let _ = stop_native_screen_capture();
                    let _ = stop_audio_capture();
                    std::process::exit(0);
                } else if label.starts_with("pip-") {
                    let peer_id = label.trim_start_matches("pip-").to_string();
                    let _ = window.app_handle().emit("pip-window-closed", peer_id);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_audio_processes,
            list_screen_sources,
            start_native_screen_capture,
            stop_native_screen_capture,
            start_audio_capture,
            stop_audio_capture,
            get_video_ws_port,
            get_video_ws_token,
            write_frontend_log,
            get_log_file_path,
            open_log_folder,
            open_latest_log,
            clear_log_file,
            open_pip_window,
            close_pip_window,
            set_pip_always_on_top,
            save_room_record,
            list_room_records,
            delete_room_record
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
