//! Camera consent belongs to the trusted desktop host, not embedded third-party pages.
#[cfg(windows)]
pub fn install(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    use webview2_com::{CoTaskMemPWSTR, PermissionRequestedEventHandler};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    let window = app.get_webview_window("main").ok_or("main webview missing")?;
    window.with_webview(|webview| unsafe {
        let result = (|| {
            let view = webview.controller().CoreWebView2()?;
            let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;
                    if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA {
                        let mut uri = Default::default();
                        args.Uri(&mut uri)?;
                        let uri = CoTaskMemPWSTR::from(uri).to_string();
                        if trusted_camera_origin(&uri) {
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                        }
                    }
                }
                Ok(())
            }));
            view.add_PermissionRequested(&handler, &mut 0)?;
            Ok::<(), Box<dyn std::error::Error>>(())
        })();
        if let Err(error) = result { eprintln!("Camera permission registration failed: {error}"); }
    })?;
    Ok(())
}

fn trusted_camera_origin(uri: &str) -> bool {
    let Ok(url) = tauri::Url::parse(uri) else { return false; };
    let packaged = url.scheme() == "http" && url.host_str() == Some("tauri.localhost") && url.port().is_none();
    let development = cfg!(debug_assertions) && url.origin().ascii_serialization() == "http://localhost:1420";
    packaged || development
}

#[cfg(not(windows))]
pub fn install(_: &tauri::App) -> Result<(), Box<dyn std::error::Error>> { Ok(()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permission_is_scoped_to_app_origin() {
        assert!(trusted_camera_origin("http://tauri.localhost/index.html"));
        for uri in ["https://youtube.com", "http://tauri.localhost.evil.com", "http://tauri.localhost:1234", "data:text/html,camera", "file:///camera.html"] {
            assert!(!trusted_camera_origin(uri), "{uri}");
        }
        assert_eq!(trusted_camera_origin("http://localhost:1420"), cfg!(debug_assertions));
    }
}
