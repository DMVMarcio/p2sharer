pub mod audio_loopback;
pub mod logger;
pub mod note_files;
pub mod youtube_playlist;
pub mod chat_files;
pub mod pip_manager;
pub mod stream_pointer;
pub mod process_manager;
pub mod room_vault;
pub mod screen_sources;
mod video_jpeg;

use audio_loopback::{start_audio_capture, stop_audio_capture};
use logger::{clear_log_file, get_log_file_path, open_latest_log, open_log_folder, write_frontend_log};
use note_files::{open_note_file, save_note_file};
use chat_files::{ChatFileState, pick_chat_file, inspect_chat_file, read_chat_file_chunk, choose_chat_download, write_chat_download_chunk, finish_chat_download, cancel_chat_download, read_chat_image_preview, remember_chat_file_source, restore_chat_file_source, reveal_chat_download};
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
use chat_files::{import_chat_files, paste_chat_files, discard_chat_file};

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
        .manage(ChatFileState::default())
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
            stream_pointer::update_stream_pointer_overlay,
            stream_pointer::get_stream_pointer_visuals,
            list_audio_processes,
            list_screen_sources,
            start_native_screen_capture,
            stop_native_screen_capture,
            screen_sources::start_capture_session,
            screen_sources::stop_capture_session,
            screen_sources::select_pointer_capture,
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
            delete_room_record,
            open_note_file,
            save_note_file,
            youtube_playlist::load_youtube_playlist,
            pick_chat_file,
            import_chat_files,
            paste_chat_files,
            discard_chat_file,
            inspect_chat_file,
            read_chat_file_chunk,
            choose_chat_download,
            write_chat_download_chunk,
            finish_chat_download,
            cancel_chat_download,
            read_chat_image_preview,
            reveal_chat_download,
            remember_chat_file_source,
            restore_chat_file_source
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
