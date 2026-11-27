//! Disable WebView2 browser commands while retaining ordinary editing shortcuts.
#[tauri::command]
pub fn disable_browser_shortcuts(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    window.with_webview(|webview| unsafe {
        use windows_capture_api::core::Interface;
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        let result = (|| {
            let settings = webview.controller().CoreWebView2()?.Settings()?;
            settings.cast::<ICoreWebView2Settings3>()?.SetAreBrowserAcceleratorKeysEnabled(false)
        })();
        if let Err(error) = result {
            crate::logger::log_msg("ERROR", "webview.shortcuts", &format!("Browser shortcut configuration failed: {error:?}"));
        }
    }).map_err(|error| error.to_string())?;
    Ok(())
}
