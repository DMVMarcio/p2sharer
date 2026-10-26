//! Camera consent belongs to the trusted desktop host, not embedded third-party pages.
#[cfg(windows)]
pub fn install(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    use webview2_com::{
        CoTaskMemPWSTR, NavigationStartingEventHandler, PermissionRequestedEventHandler,
    };
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, ICoreWebView2_4,
        ICoreWebView2NavigationStartingEventArgs2,
    };
    use windows_capture_api::core::{HSTRING, Interface, PCWSTR};
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

            let allowed = HSTRING::from("http://tauri.localhost https://tauri.localhost http://localhost:1420");
            let frame_allowed = allowed.clone();
            let frame_handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    if let Ok(args2) = args.cast::<ICoreWebView2NavigationStartingEventArgs2>() {
                        let _ = args2.SetAdditionalAllowedFrameAncestors(PCWSTR(frame_allowed.as_ptr()));
                    }
                }
                Ok(())
            }));
            if let Ok(core4) = view.cast::<ICoreWebView2_4>() {
                let _ = core4.add_FrameNavigationStarting(&frame_handler, &mut 0);
            }

            let nav_allowed = allowed;
            let nav_handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    if let Ok(args2) = args.cast::<ICoreWebView2NavigationStartingEventArgs2>() {
                        let _ = args2.SetAdditionalAllowedFrameAncestors(PCWSTR(nav_allowed.as_ptr()));
                    }
                }
                Ok(())
            }));
            let _ = view.add_NavigationStarting(&nav_handler, &mut 0);

            Ok::<(), Box<dyn std::error::Error>>(())
        })();
        if let Err(error) = result { crate::logger::log_msg("ERROR", "camera.permission", &format!("WebView2 permission handler registration failed: {error:?}")); }
    })?;
    Ok(())
}

fn trusted_camera_origin(uri: &str) -> bool {
    let Ok(url) = tauri::Url::parse(uri) else { return false; };
    let packaged = (url.scheme() == "http" || url.scheme() == "https") && url.host_str() == Some("tauri.localhost") && url.port().is_none();
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
        assert!(trusted_camera_origin("https://tauri.localhost/index.html"));
        for uri in ["https://youtube.com", "http://tauri.localhost.evil.com", "http://tauri.localhost:1234", "data:text/html,camera", "file:///camera.html"] {
            assert!(!trusted_camera_origin(uri), "{uri}");
        }
        assert_eq!(trusted_camera_origin("http://localhost:1420"), cfg!(debug_assertions));
    }
}
