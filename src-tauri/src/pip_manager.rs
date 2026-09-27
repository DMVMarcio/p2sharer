use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || byte == b'.' || byte == b'~' {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

#[tauri::command]
pub async fn open_pip_window(app: AppHandle, peer_id: String, title: String) -> Result<(), String> {
    let sanitized_id: String = peer_id
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let label = format!("pip-{}", sanitized_id);

    // If window already exists, bring it to front
    if let Some(existing_window) = app.get_webview_window(&label) {
        let _ = existing_window.show();
        let _ = existing_window.set_focus();
        return Ok(());
    }

    let encoded_peer = encode_uri_component(&peer_id);
    let url_str = format!("index.html?pip={}", encoded_peer);
    let win_title = if title.trim().is_empty() {
        "P2Sharer - Picture-in-Picture".to_string()
    } else {
        format!("P2Sharer - {}", title.trim())
    };

    let builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(url_str.into()),
    )
    .title(&win_title)
    .inner_size(800.0, 480.0)
    .min_inner_size(320.0, 180.0)
    .resizable(true)
    .decorations(false)
    .always_on_top(true)
    .shadow(true);

    builder.build().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn close_pip_window(app: AppHandle, peer_id: String) -> Result<(), String> {
    let sanitized_id: String = peer_id
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let label = format!("pip-{}", sanitized_id);

    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.close();
    }
    let _ = app.emit("pip-window-closed", peer_id);
    Ok(())
}

#[tauri::command]
pub async fn set_pip_always_on_top(app: AppHandle, peer_id: String, always_on_top: bool) -> Result<(), String> {
    let sanitized_id: String = peer_id
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let label = format!("pip-{}", sanitized_id);

    if let Some(win) = app.get_webview_window(&label) {
        win.set_always_on_top(always_on_top).map_err(|e| e.to_string())?;
    }
    Ok(())
}
