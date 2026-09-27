pub mod audio_loopback;
pub mod logger;
pub mod process_manager;
pub mod screen_sources;
pub mod telemetry;

use audio_loopback::{start_audio_capture, stop_audio_capture};
use logger::{clear_log_file, get_log_file_path, open_latest_log, open_log_folder, write_frontend_log};
use process_manager::{
    check_or_create_single_instance_mutex, focus_existing_instance_window,
    list_audio_processes, setup_job_object_for_clean_child_teardown,
};
use screen_sources::{
    ensure_ws_server_running, get_video_ws_port, list_screen_sources, start_native_screen_capture,
    stop_native_screen_capture,
};
use telemetry::get_system_telemetry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 1. Single instance check: bring existing window to focus and exit duplicate
    if !check_or_create_single_instance_mutex() {
        focus_existing_instance_window();
        std::process::exit(0);
    }

    // 2. Bind process to Windows Job Object to guarantee atomic child teardown on exit
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
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let _ = stop_native_screen_capture();
                let _ = stop_audio_capture();
                std::process::exit(0);
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
            write_frontend_log,
            get_log_file_path,
            open_log_folder,
            open_latest_log,
            clear_log_file,
            get_system_telemetry
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
