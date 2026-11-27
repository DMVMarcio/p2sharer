//! Twitch authentication window management and session synchronization.
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const TWITCH_AUTH_WINDOW_LABEL: &str = "twitch-auth";

/// Determines whether a URL is a Twitch authentication/sign-in page.
pub fn is_twitch_auth_url(uri: &str) -> bool {
    let Ok(url) = tauri::Url::parse(uri) else { return false; };
    let host = url.host_str().unwrap_or("");
    if host == "id.twitch.tv" || host == "passport.twitch.tv" {
        return true;
    }
    if host.ends_with("twitch.tv") {
        let path = url.path();
        if path.starts_with("/login") || path.starts_with("/signup") || path.starts_with("/auth") {
            return true;
        }
        if let Some(query) = url.query() {
            if query.contains("action=login") || query.contains("redirect_on_login") {
                return true;
            }
        }
    }
    false
}

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
            if url.host_str().is_some_and(|h| h.ends_with("twitch.tv")) && (url.path() == "/" || url.path().is_empty() || url.path().starts_with("/directory")) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_twitch_auth_url() {
        assert!(is_twitch_auth_url("https://www.twitch.tv/login"));
        assert!(is_twitch_auth_url("https://www.twitch.tv/signup"));
        assert!(is_twitch_auth_url("https://id.twitch.tv/oauth2/authorize?client_id=xyz"));
        assert!(is_twitch_auth_url("https://passport.twitch.tv/sessions/new"));
        assert!(is_twitch_auth_url("https://www.twitch.tv/popout/channel/chat?action=login"));

        // Non-auth URLs should be rejected so they open in the user's browser without reloading the player
        assert!(!is_twitch_auth_url("https://www.twitch.tv/subs/streamer"));
        assert!(!is_twitch_auth_url("https://www.twitch.tv/products/sub_tier1"));
        assert!(!is_twitch_auth_url("https://www.twitch.tv/bits"));
        assert!(!is_twitch_auth_url("https://www.twitch.tv/gaules"));
        assert!(!is_twitch_auth_url("https://google.com"));
        assert!(!is_twitch_auth_url("not a url"));
    }
}
