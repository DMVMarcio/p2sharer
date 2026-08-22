pub mod audio_loopback;
pub mod logger;
pub mod process_manager;
pub mod screen_sources;

use audio_loopback::{start_audio_capture, stop_audio_capture};
use logger::{clear_log_file, get_log_file_path, open_latest_log, open_log_folder, write_frontend_log};
use process_manager::list_audio_processes;
use screen_sources::{
    ensure_ws_server_running, get_video_ws_port, list_screen_sources, start_native_screen_capture,
    stop_native_screen_capture,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logger::init_logger();
    ensure_ws_server_running();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            clear_log_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
