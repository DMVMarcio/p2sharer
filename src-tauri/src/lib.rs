#[cfg(all(test, windows))]
mod test_support;

pub mod profile_image;
pub mod audio_loopback;
pub mod logger;
mod media_diagnostics;
pub mod note_files;
pub mod youtube_playlist;
pub mod chat_files;
pub mod pip_manager;
pub mod stream_pointer;
pub mod process_manager;
pub mod room_vault;
pub mod screen_sources;
mod video_jpeg;
mod video_load;
mod video_pacer;
mod native_rtc;
#[cfg(windows)]
mod video_readback;
#[cfg(windows)]
mod video_gpu_scale;
#[cfg(windows)]
mod video_nvenc;
mod camera_permission;
mod browser_shortcuts;
mod window_chrome;
mod localization;
mod app_data_migration;
mod app_updates;
pub mod lan_signaling;

use audio_loopback::{start_audio_capture, stop_audio_capture};
use logger::{clear_log_file, get_log_file_path, open_latest_log, open_log_folder, write_frontend_log};
use note_files::{open_note_file, save_note_file};
use chat_files::{ChatFileState, pick_chat_file, inspect_chat_file, read_chat_file_chunk, choose_chat_download, write_chat_download_chunk, finish_chat_download, cancel_chat_download, read_chat_image_preview, remember_chat_file_source, restore_chat_file_source, reveal_chat_download};
use pip_manager::{close_pip_window, open_pip_window, set_pip_always_on_top, set_pip_aspect_ratio};
use process_manager::{
    list_audio_processes, setup_job_object_for_clean_child_teardown,
};
use room_vault::{delete_room_record, list_room_records, save_room_record};
use screen_sources::{
    ensure_ws_server_running, get_video_ws_port, get_video_ws_token, list_screen_sources, start_native_screen_capture,
    stop_native_screen_capture,
};

use tauri::{Emitter, Manager};
use chat_files::{import_chat_files, paste_chat_files, discard_chat_file, copy_chat_image};

#[tauri::command]
fn prepare_app_update(window: tauri::Window) -> Result<(), String> {
    if window.label() != "main" { return Err("Only the main window can install updates".into()); }
    stop_native_screen_capture()?;
    stop_audio_capture()?;
    process_manager::set_update_installer_breakaway(true)?;
    Ok(())
}

#[tauri::command]
fn cancel_app_update(window: tauri::Window) -> Result<(), String> {
    if window.label() != "main" { return Err("Only the main window can cancel update preparation".into()); }
    process_manager::set_update_installer_breakaway(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app_data_migration::migrate_legacy_data().expect("Could not migrate previous application data; close older P2Sharer instances and retry");
    // Bind process to Windows Job Object to guarantee atomic child teardown on exit.
    setup_job_object_for_clean_child_teardown();

    #[cfg(windows)]
    {
        // Enable GPU hardware rasterization, zero-copy video pipeline, WebCodecs & WebRTC HW acceleration in WebView2
        let current_args = lan_signaling::browser_arguments(
            &std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default());
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", &current_args);
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
    media_diagnostics::init();
    ensure_ws_server_running();

    tauri::Builder::default()
        .manage(ChatFileState::default())
        .manage(profile_image::ProfileImageState::default())
        .manage(lan_signaling::LanSignalingState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            camera_permission::install(app)?;
            browser_shortcuts::disable_browser_shortcuts(app.get_webview_window("main").ok_or("main webview missing")?)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let label = window.label();
                if label == "main" {
                    let _ = stop_native_screen_capture();
                    let _ = stop_audio_capture();
                } else if label.starts_with("pip-") {
                    let peer_id = label.trim_start_matches("pip-").to_string();
                    let _ = window.app_handle().emit("pip-window-closed", peer_id);
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "main" {
                std::process::exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            profile_image::pick_profile_image,
            profile_image::discard_profile_image,
            profile_image::save_profile_image,
            profile_image::load_profile_image,
            profile_image::validate_profile_image,
            media_diagnostics::media_diagnostics_enabled,
            media_diagnostics::write_media_diagnostics,
            lan_signaling::list_lan_interfaces,
            lan_signaling::start_lan_signaling,
            lan_signaling::stop_lan_signaling,
            lan_signaling::connect_lan_signaling,
            lan_signaling::send_lan_signaling,
            lan_signaling::disconnect_lan_signaling,
            app_updates::check_app_update,
            prepare_app_update,
            cancel_app_update,
            browser_shortcuts::disable_browser_shortcuts,
            window_chrome::show_window_menu,
            localization::get_system_locale,
            native_rtc::create_native_video_offer,
            native_rtc::answer_native_video,
            native_rtc::add_native_video_ice,
            native_rtc::close_native_video,
            native_rtc::set_native_video_bitrate,
            native_rtc::get_native_video_stats,
            stream_pointer::update_stream_pointer_overlay,
            stream_pointer::get_stream_pointer_visuals,
            list_audio_processes,
            list_screen_sources,
            start_native_screen_capture,
            stop_native_screen_capture,
            screen_sources::start_capture_session,
            screen_sources::get_native_encoder_support,
            screen_sources::control_capture_encoder,
            screen_sources::get_capture_metrics,
            screen_sources::report_capture_load,
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
            set_pip_aspect_ratio,
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
            restore_chat_file_source,
            copy_chat_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
