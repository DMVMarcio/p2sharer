#[cfg(all(test, windows))]
mod test_support;

#[path = "files/profile_image.rs"]
pub mod profile_image;
#[path = "audio/audio_loopback.rs"]
pub mod audio_loopback;
pub mod logger;
#[path = "diagnostics/media_diagnostics.rs"]
mod media_diagnostics;
#[path = "files/note_files.rs"]
pub mod note_files;
#[path = "integrations/youtube_playlist.rs"]
pub mod youtube_playlist;
#[path = "files/chat_files.rs"]
pub mod chat_files;
#[path = "files/chat_file_direct.rs"]
mod chat_file_direct;
#[path = "app/pip_manager.rs"]
pub mod pip_manager;
#[path = "input/stream_pointer.rs"]
pub mod stream_pointer;
#[path = "input/remote_control.rs"]
pub mod remote_control;
#[path = "input/remote_control_helper.rs"]
pub mod remote_control_helper;
#[path = "input/voice_shortcuts.rs"]
pub mod voice_shortcuts;
#[path = "input/gamepad.rs"]
pub mod gamepad;
#[path = "audio/process_manager.rs"]
pub mod process_manager;
#[path = "files/room_vault.rs"]
pub mod room_vault;
#[path = "video/screen_sources.rs"]
pub mod screen_sources;
#[path = "video/capture_recovery.rs"]
mod capture_recovery;
#[path = "video/video_jpeg.rs"]
mod video_jpeg;
#[path = "video/video_load.rs"]
mod video_load;
#[path = "video/video_pacer.rs"]
mod video_pacer;
#[path = "network/native_rtc.rs"]
mod native_rtc;
#[cfg(windows)]
#[path = "video/video_readback.rs"]
mod video_readback;
#[cfg(windows)]
#[path = "video/video_gpu_scale.rs"]
mod video_gpu_scale;
#[cfg(windows)]
#[path = "video/video_dxgi.rs"]
mod video_dxgi;
#[cfg(windows)]
#[path = "video/video_nvenc.rs"]
mod video_nvenc;
#[cfg(windows)]
#[path = "video/video_hardware.rs"]
mod video_hardware;
#[path = "video/camera_permission.rs"]
mod camera_permission;
#[path = "browser/browser_shortcuts.rs"]
mod browser_shortcuts;
#[path = "browser/shared_browser.rs"]
pub mod shared_browser;
#[path = "app/window_chrome.rs"]
mod window_chrome;
#[cfg(windows)]
#[path = "app/window_placement.rs"]
mod window_placement;
#[path = "app/localization.rs"]
mod localization;
#[path = "app/app_data_migration.rs"]
mod app_data_migration;
#[path = "app/invitation_routing.rs"]
mod invitation_routing;
#[path = "app/app_updates.rs"]
mod app_updates;
#[path = "app/app_distribution.rs"]
mod app_distribution;
#[path = "app/portable_update.rs"]
pub mod portable_update;
#[path = "network/lan_signaling.rs"]
pub mod lan_signaling;
#[path = "network/interface_stun.rs"]
mod interface_stun;
#[path = "network/port_tunnel.rs"]
pub mod port_tunnel;
#[path = "network/native_tunnel.rs"]
pub mod native_tunnel;
#[path = "network/peer_payload.rs"]
mod peer_payload;
#[path = "network/traffic_counters.rs"]
mod traffic_counters;
#[path = "virtual_network/virtual_network.rs"]
pub mod virtual_network;
#[path = "network/upnp.rs"]
pub mod upnp;
#[path = "network/network_diagnostic.rs"]
pub mod network_diagnostic;
#[path = "diagnostics/performance_diagnostic.rs"]
pub mod performance_diagnostic;
#[path = "integrations/twitch_auth.rs"]
pub mod twitch_auth;
#[path = "virtual_network/virtual_network_policy.rs"]
mod virtual_network_policy;
#[cfg(all(windows, target_arch = "x86_64"))]
#[path = "virtual_network/virtual_network_driver.rs"]
mod virtual_network_driver;

use audio_loopback::{start_audio_capture, stop_audio_capture};
use logger::{clear_log_file, get_log_file_path, open_latest_log, open_log_folder, write_frontend_log};
use note_files::{open_note_file, save_note_file, list_saved_notes, read_saved_note, save_library_note, rename_library_note, delete_library_note};
use chat_files::{ChatFileState, pick_chat_file, inspect_chat_file, read_chat_file_chunk, read_chat_file_bytes, choose_chat_download, write_chat_download_chunk, write_chat_download_bytes, finish_chat_download, cancel_chat_download, read_chat_image_preview, remember_chat_file_source, restore_chat_file_source, reveal_chat_download};
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
async fn prepare_app_update(app: tauri::AppHandle, window: tauri::Window, network: tauri::State<'_, virtual_network::VirtualNetworkState>, browser: tauri::State<'_, shared_browser::BrowserState>) -> Result<(), String> {
    if window.label() != "main" { return Err("Only the main window can install updates".into()); }
    stop_native_screen_capture()?;
    stop_audio_capture()?;
    browser.shutdown(&app).await;
    network.shutdown().await?;
    process_manager::set_update_installer_breakaway(true)?;
    Ok(())
}

#[tauri::command]
fn cancel_app_update(window: tauri::Window) -> Result<(), String> {
    if window.label() != "main" { return Err("Only the main window can cancel update preparation".into()); }
    process_manager::set_update_installer_breakaway(false)
}

static EXIT_WATCHDOG_ARMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn shutdown_native_subsystems() {
    voice_shortcuts::shutdown();
    remote_control::shutdown_remote_control();
    gamepad::shutdown_gamepads();
    let _ = stop_native_screen_capture();
    let _ = stop_audio_capture();
    chat_files::sweep_chat_clipboard();
}

#[tauri::command]
fn arm_exit_watchdog(window: tauri::Window) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can arm the exit watchdog".into());
    }
    if !EXIT_WATCHDOG_ARMED.swap(true, std::sync::atomic::Ordering::AcqRel) {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(4));
            shutdown_native_subsystems();
            std::process::exit(0);
        });
    }
    Ok(())
}

#[tauri::command]
fn exit_application(app: tauri::AppHandle) -> Result<(), String> {
    shutdown_native_subsystems();
    app.exit(0);
    std::process::exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if invitation_routing::forward_startup_invitation() { return; }
    app_data_migration::migrate_legacy_data().expect("Could not migrate previous application data; close older P2Sharer instances and retry");
    chat_files::sweep_chat_clipboard();
    // Bind process to Windows Job Object to guarantee atomic child teardown on exit.
    setup_job_object_for_clean_child_teardown();

    #[cfg(windows)]
    {
        // Enable GPU hardware rasterization, zero-copy video pipeline, WebCodecs & WebRTC HW acceleration in WebView2
        let current_args = lan_signaling::browser_arguments(
            &std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default());
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", &current_args);
        if !current_args.contains("--enable-blink-features=MediaStreamTrackGenerator") {
            let extra_args = "--ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy --enable-accelerated-video-decode --enable-accelerated-video-encode --enable-webrtc-hw-h264-encoding --enable-webrtc-hw-vp8-encoding --enable-gpu-memory-buffer-video-frames --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required --enable-features=WebRtcHardwareVideoEncoding,WebRtcHardwareVideoDecoding,AcceleratedVideoEncoder,AcceleratedVideoDecoder,MediaStreamTrackGenerator --enable-blink-features=MediaStreamTrackGenerator";
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
        .plugin(tauri_plugin_deep_link::init())
        .manage(ChatFileState::default())
        .manage(chat_file_direct::DirectFileState::default())
        .manage(shared_browser::BrowserState::default())
        .manage(profile_image::ProfileImageState::default())
        .manage(lan_signaling::LanSignalingState::default())
        .manage(interface_stun::InterfaceStunState::default())
        .manage(port_tunnel::TunnelState::default())
        .manage(peer_payload::PayloadState::default())
        .manage(virtual_network::VirtualNetworkState::default())
        .manage(upnp::UpnpState::default())
        .manage(performance_diagnostic::PerformanceDiagState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let main = app.get_webview_window("main").ok_or("main webview missing")?;
            let upnp_state = app.state::<upnp::UpnpState>().inner().clone();
            tauri::async_runtime::spawn(async move { upnp_state.init_discovery().await; });
            #[cfg(windows)]
            let was_maximized = match window_placement::install(&main) {
                Ok(maximized) => maximized,
                Err(error) => { eprintln!("[Window] Could not restore placement: {error}"); false }
            };
            main.show()?;
            #[cfg(windows)]
            if was_maximized {
                let _ = main.maximize();
            }
            invitation_routing::install(app.handle())?;
            camera_permission::install(app)?;
            browser_shortcuts::disable_browser_shortcuts(app.get_webview_window("main").ok_or("main webview missing")?)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(windows)]
            window_placement::on_event(window, event);
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let label = window.label();
                if label == "main" {
                    std::thread::spawn(|| {
                        remote_control::shutdown_remote_control();
                        let _ = stop_native_screen_capture();
                        let _ = stop_audio_capture();
                    });
                } else if label.starts_with("pip-") {
                    let peer_id = label.trim_start_matches("pip-").to_string();
                    let _ = window.app_handle().emit("pip-window-closed", peer_id);
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "main" {
                shutdown_native_subsystems();
                std::process::exit(0);
            }
        })
        .invoke_handler(|invoke| {
            if invoke.message.webview().label().starts_with("browser-") {
                invoke.resolver.reject("Browser pages cannot invoke application commands");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            shared_browser::start_shared_browser,
            shared_browser::read_shared_browser_selection,
            shared_browser::stop_shared_browser,
            shared_browser::set_shared_browser_volume,
            shared_browser::control_shared_browser,
            shared_browser::prepare_shared_browser_capture,
            shared_browser::clear_shared_browser,
            shared_browser::browser_extensions,
            shared_browser::resolve_browser_dialog,
            virtual_network::get_virtual_network_identity,
            virtual_network::prepare_virtual_network_app,
            virtual_network::regenerate_virtual_network_ip,
            virtual_network::configure_virtual_network,
            virtual_network::stop_virtual_network_scope,
            virtual_network::get_virtual_network_status,
            virtual_network::virtual_network_sent,
            virtual_network::receive_virtual_network_packet,
            port_tunnel::configure_port_tunnels,
            port_tunnel::stop_port_tunnels,
            port_tunnel::get_port_tunnel_status,
            port_tunnel::connect_port_tunnel,
            port_tunnel::disconnect_port_tunnel,
            port_tunnel::receive_port_tunnel,
            native_tunnel::connect_native_tunnel_peer,
            native_tunnel::signal_native_tunnel_peer,
            peer_payload::subscribe_tunnel_payloads,
            peer_payload::unsubscribe_tunnel_payloads,
            peer_payload::receive_tunnel_payload,
            profile_image::pick_profile_image,
            profile_image::discard_profile_image,
            profile_image::save_profile_image,
            profile_image::load_profile_image,
            profile_image::validate_profile_image,
            profile_image::validate_profile_image_bytes,
            profile_image::pick_whiteboard_image,
            profile_image::paste_whiteboard_image,
            profile_image::validate_whiteboard_image,
            media_diagnostics::media_diagnostics_enabled,
            media_diagnostics::write_media_diagnostics,
            lan_signaling::list_lan_interfaces,
            interface_stun::get_interface_stun_servers,
            lan_signaling::start_lan_signaling,
            lan_signaling::stop_lan_signaling,
            lan_signaling::connect_lan_signaling,
            lan_signaling::send_lan_signaling,
            lan_signaling::disconnect_lan_signaling,
            app_updates::check_app_update,
            app_distribution::store_managed_updates,
            twitch_auth::open_twitch_auth,
            portable_update::download_portable_update,
            portable_update::install_portable_update,
            portable_update::restart_after_update,
            upnp::get_upnp_status,
            upnp::request_upnp_port,
            network_diagnostic::run_network_diagnostics,
            performance_diagnostic::perf_diag_start,
            performance_diagnostic::perf_diag_sample,
            performance_diagnostic::perf_diag_finish,
            performance_diagnostic::perf_diag_cancel,
            performance_diagnostic::export_performance_report,
            performance_diagnostic::save_performance_report_to_logs,
            prepare_app_update,
            cancel_app_update,
            arm_exit_watchdog,
            exit_application,
            browser_shortcuts::disable_browser_shortcuts,
            window_chrome::show_window_menu,
            window_placement::capture_window_placement,
            window_placement::restore_window_placement,
            localization::get_system_locale,
            native_rtc::create_native_video_offer,
            native_rtc::answer_native_video,
            native_rtc::add_native_video_ice,
            native_rtc::close_native_video,
            native_rtc::set_native_video_bitrate,
            native_rtc::get_native_video_stats,
            stream_pointer::update_stream_pointer_overlay,
            stream_pointer::get_stream_pointer_visuals,
            remote_control::set_remote_control_active,
            remote_control::set_remote_control_native_peer,
            remote_control::apply_remote_control_input,
            remote_control::release_remote_control_inputs,
            remote_control::set_remote_control_immersive,
            remote_control::set_remote_control_cursor_clip,
            remote_control::set_remote_control_mouse_lock,
            remote_control::set_remote_control_host_priority_enabled,
            remote_control::enable_remote_control_elevation,
            remote_control::is_remote_control_elevation_ready,
            remote_control::set_remote_control_controller_elevation,
            voice_shortcuts::configure_voice_shortcuts,
            gamepad::get_remote_control_gamepads,
            gamepad::recheck_remote_control_gamepad_driver,
            gamepad::reorder_remote_control_gamepads,
            gamepad::disconnect_remote_control_gamepad,
            gamepad::install_remote_control_gamepad_driver,
            list_audio_processes,
            list_screen_sources,
            start_native_screen_capture,
            stop_native_screen_capture,
            screen_sources::start_capture_session,
            screen_sources::get_native_encoder_support,
            screen_sources::control_capture_encoder,
            screen_sources::get_capture_metrics,
            screen_sources::update_capture_profile,
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
            list_saved_notes,
            read_saved_note,
            save_library_note,
            rename_library_note,
            delete_library_note,
            youtube_playlist::load_youtube_playlist,
            pick_chat_file,
            import_chat_files,
            paste_chat_files,
            discard_chat_file,
            inspect_chat_file,
            read_chat_file_chunk,
            read_chat_file_bytes,
            chat_file_direct::offer_direct_chat_file,
            chat_file_direct::receive_direct_chat_file,
            chat_file_direct::cancel_direct_chat_file,
            write_chat_download_bytes,
            choose_chat_download,
            write_chat_download_chunk,
            finish_chat_download,
            cancel_chat_download,
            read_chat_image_preview,
            reveal_chat_download,
            remember_chat_file_source,
            restore_chat_file_source,
            copy_chat_image
            ];
            handler(invoke)
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                shutdown_native_subsystems();
                std::process::exit(0);
            }
        });
}
