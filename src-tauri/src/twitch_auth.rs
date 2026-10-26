//! Twitch authentication window management and session synchronization.
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const TWITCH_AUTH_WINDOW_LABEL: &str = "twitch-auth";

#[tauri::command]
pub async fn open_twitch_auth(app: AppHandle, url: Option<String>) -> Result<(), String> {
    open_twitch_auth_window(&app, url.as_deref())
}

pub fn open_twitch_auth_window(app: &AppHandle, url_str: Option<&str>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(TWITCH_AUTH_WINDOW_LABEL) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let default_url = "https://www.twitch.tv/login";
    let target = url_str.unwrap_or(default_url);
    let Ok(parsed_url) = tauri::Url::parse(target) else {
        return Err("Invalid Twitch authentication URL".into());
    };

    if !parsed_url.host_str().is_some_and(|h| h.ends_with("twitch.tv")) {
        return Err("Only Twitch domains are allowed for Twitch authentication".into());
    }

    let app_handle = app.clone();
    let win = WebviewWindowBuilder::new(app, TWITCH_AUTH_WINDOW_LABEL, WebviewUrl::External(parsed_url))
        .title("Twitch - Login")
        .inner_size(520.0, 740.0)
        .center()
        .resizable(true)
        .decorations(true)
        .always_on_top(true)
        .on_navigation(move |url| {
            if url.host_str() == Some("www.twitch.tv") && (url.path() == "/" || url.path().is_empty()) {
                let _ = app_handle.emit_to("main", "twitch-auth-success", ());
            }
            true
        })
        .build()
        .map_err(|e| e.to_string())?;

    let close_app = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            let _ = close_app.emit_to("main", "twitch-auth-closed", ());
        }
    });

    Ok(())
}
