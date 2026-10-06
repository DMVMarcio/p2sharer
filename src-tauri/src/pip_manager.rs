use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

fn video_ratio(width: Option<u32>, height: Option<u32>) -> f64 {
    match (width, height) {
        (Some(w), Some(h)) if w > 0 && h > 0 && w <= 65536 && h <= 65536 => w as f64 / h as f64,
        _ => 16.0 / 9.0,
    }
}

fn fit_video_size(ratio: f64, max_width: f64, max_height: f64) -> (f64, f64) {
    let width = max_width.min(max_height * ratio).max(1.0);
    (width, (width / ratio).max(1.0))
}

#[cfg(windows)]
mod proportional_resize {
    use windows::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
        UI::{
            HiDpi::GetDpiForWindow,
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                GetClientRect, GetWindowRect, WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_BOTTOMRIGHT, WMSZ_LEFT, WMSZ_TOP,
                WMSZ_TOPLEFT, WMSZ_TOPRIGHT, WM_NCDESTROY, WM_SIZING,
            },
        },
    };

    const SUBCLASS_ID: usize = 0x503250;

    pub fn constrain(
        rect: &mut RECT,
        edge: u32,
        ratio: f64,
        frame: (i32, i32),
        min_width: f64,
        height_driven: bool,
    ) {
        let width = (rect.right - rect.left - frame.0).max(1) as f64;
        let height = (rect.bottom - rect.top - frame.1).max(1) as f64;
        let width = if edge == WMSZ_TOP || edge == WMSZ_BOTTOM || height_driven {
            height * ratio
        } else {
            width
        }
        .max(min_width);
        let outer_width = width.round() as i32 + frame.0;
        let outer_height = (width / ratio).round() as i32 + frame.1;
        if matches!(edge, WMSZ_LEFT | WMSZ_TOPLEFT | WMSZ_BOTTOMLEFT) {
            rect.left = rect.right - outer_width;
        } else {
            rect.right = rect.left + outer_width;
        }
        if matches!(edge, WMSZ_TOP | WMSZ_TOPLEFT | WMSZ_TOPRIGHT) {
            rect.top = rect.bottom - outer_height;
        } else {
            rect.bottom = rect.top + outer_height;
        }
    }

    unsafe extern "system" fn resize_proc(
        hwnd: HWND,
        message: u32,
        wp: WPARAM,
        lp: LPARAM,
        id: usize,
        data: usize,
    ) -> LRESULT {
        if message == WM_NCDESTROY {
            let _ = RemoveWindowSubclass(hwnd, Some(resize_proc), id);
        }
        let result = DefSubclassProc(hwnd, message, wp, lp);
        if message == WM_SIZING && lp.0 != 0 {
            let ratio = f32::from_bits(data as u32) as f64;
            let mut outer = RECT::default();
            let mut client = RECT::default();
            if GetWindowRect(hwnd, &mut outer).is_ok() && GetClientRect(hwnd, &mut client).is_ok() {
                let frame = (
                    outer.right - outer.left - client.right,
                    outer.bottom - outer.top - client.bottom,
                );
                let dpi = GetDpiForWindow(hwnd).max(96) as f64 / 96.0;
                let requested = &mut *(lp.0 as *mut RECT);
                // Corner resizing follows whichever dimension changed most, so a
                // vertical-only corner drag still grows the proportional window.
                let corner = matches!(
                    wp.0 as u32,
                    WMSZ_TOPLEFT | WMSZ_TOPRIGHT | WMSZ_BOTTOMLEFT | WMSZ_BOTTOMRIGHT
                );
                let height_driven = corner
                    && ((requested.bottom - requested.top - frame.1 - client.bottom) as f64).abs()
                        * ratio
                        > ((requested.right - requested.left - frame.0 - client.right) as f64)
                            .abs();
                constrain(
                    requested,
                    wp.0 as u32,
                    ratio,
                    frame,
                    320.0 * dpi,
                    height_driven,
                );
                return LRESULT(1);
            }
        }
        result
    }

    // Called only on the window's owning UI thread; updating reference data
    // changes the ratio without allocating callback state or replacing Tao's proc.
    pub unsafe fn install(hwnd: HWND, ratio: f64) -> Result<(), String> {
        if SetWindowSubclass(
            hwnd,
            Some(resize_proc),
            SUBCLASS_ID,
            (ratio as f32).to_bits() as usize,
        )
        .as_bool()
        {
            Ok(())
        } else {
            Err("Failed to constrain PiP resizing".into())
        }
    }
}

async fn apply_video_ratio(window: WebviewWindow, ratio: f64) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                let scale = target.scale_factor().map_err(|e| e.to_string())?;
                let current = target.inner_size().map_err(|e| e.to_string())?;
                let mut max_width = current.width as f64 / scale;
                let mut max_height = max_width / ratio;
                if let Some(monitor) = target.current_monitor().map_err(|e| e.to_string())? {
                    max_width = max_width.min(monitor.work_area().size.width as f64 / scale * 0.9);
                    max_height =
                        max_height.min(monitor.work_area().size.height as f64 / scale * 0.9);
                }
                let (width, height) = fit_video_size(ratio, max_width, max_height);
                #[cfg(windows)]
                unsafe {
                    let raw = target.hwnd().map_err(|e| e.to_string())?;
                    proportional_resize::install(
                        windows::Win32::Foundation::HWND(raw.0 as _),
                        ratio,
                    )?;
                }
                target
                    .set_min_size(Some(LogicalSize::new(320.0, 320.0 / ratio)))
                    .map_err(|e| e.to_string())?;
                target
                    .set_size(LogicalSize::new(width, height))
                    .map_err(|e| e.to_string())?;
                Ok(())
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_pip_aspect_ratio(
    window: WebviewWindow,
    video_width: u32,
    video_height: u32,
) -> Result<(), String> {
    if !window.label().starts_with("pip-")
        || video_width == 0
        || video_height == 0
        || video_width > 65536
        || video_height > 65536
    {
        return Err("Invalid PiP video dimensions or window".into());
    }
    apply_video_ratio(window, video_ratio(Some(video_width), Some(video_height))).await
}

fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric()
            || byte == b'-'
            || byte == b'_'
            || byte == b'.'
            || byte == b'~'
        {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

#[tauri::command]
pub async fn open_pip_window(
    app: AppHandle,
    peer_id: String,
    title: String,
    video_width: Option<u32>,
    video_height: Option<u32>,
) -> Result<(), String> {
    let sanitized_id: String = peer_id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let label = format!("pip-{}", sanitized_id);

    // If window already exists, bring it to front
    if let Some(existing_window) = app.get_webview_window(&label) {
        let _ = existing_window.show();
        let _ = existing_window.set_focus();
        return Ok(());
    }

    let encoded_peer = encode_uri_component(&peer_id);
    let encoded_title = encode_uri_component(title.trim());
    let url_str = format!("index.html?pip={}&name={}", encoded_peer, encoded_title);
    let win_title = if title.trim().is_empty() {
        "P2Sharer - Picture-in-Picture".to_string()
    } else {
        format!("P2Sharer - {}", title.trim())
    };

    let ratio = video_ratio(video_width, video_height);
    let (width, height) = fit_video_size(ratio, 800.0, 600.0);
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url_str.into()))
        .title(&win_title)
        .inner_size(width, height)
        .min_inner_size(320.0, 320.0 / ratio)
        .maximizable(false)
        .resizable(true)
        .decorations(false)
        .always_on_top(true)
        .shadow(true);

    let window = builder.build().map_err(|e| e.to_string())?;
    apply_video_ratio(window, ratio).await?;

    Ok(())
}

#[tauri::command]
pub async fn close_pip_window(app: AppHandle, peer_id: String) -> Result<(), String> {
    let sanitized_id: String = peer_id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let label = format!("pip-{}", sanitized_id);

    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.close();
    }
    let _ = app.emit("pip-window-closed", peer_id);
    Ok(())
}

#[tauri::command]
pub async fn set_pip_always_on_top(
    app: AppHandle,
    peer_id: String,
    always_on_top: bool,
) -> Result<(), String> {
    let sanitized_id: String = peer_id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let label = format!("pip-{}", sanitized_id);

    if let Some(win) = app.get_webview_window(&label) {
        win.set_always_on_top(always_on_top)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_sizes_fit_landscape_portrait_and_ultrawide_without_distortion() {
        for ratio in [16.0 / 9.0, 9.0 / 16.0, 32.0 / 9.0, 1.0] {
            let (width, height) = fit_video_size(ratio, 800.0, 600.0);
            assert!(width <= 800.0 && height <= 600.0);
            assert!((width / height - ratio).abs() < 0.000001);
        }
        assert_eq!(video_ratio(Some(0), Some(1080)), 16.0 / 9.0);
    }

    #[cfg(windows)]
    #[test]
    fn resizing_every_edge_preserves_client_aspect_and_opposite_anchor() {
        use windows::Win32::{Foundation::RECT, UI::WindowsAndMessaging::*};
        for ratio in [16.0 / 9.0, 9.0 / 16.0, 32.0 / 9.0, 1.0] {
            for edge in 1..=8 {
                let mut rect = RECT {
                    left: 100,
                    top: 100,
                    right: 1000,
                    bottom: 700,
                };
                proportional_resize::constrain(&mut rect, edge, ratio, (16, 16), 320.0, false);
                let width = (rect.right - rect.left - 16) as f64;
                let height = (rect.bottom - rect.top - 16) as f64;
                assert!((height - width / ratio).abs() <= 1.0);
                assert!(width >= 320.0);
                if matches!(edge, WMSZ_LEFT | WMSZ_TOPLEFT | WMSZ_BOTTOMLEFT) {
                    assert_eq!(rect.right, 1000);
                } else {
                    assert_eq!(rect.left, 100);
                }
                if matches!(edge, WMSZ_TOP | WMSZ_TOPLEFT | WMSZ_TOPRIGHT) {
                    assert_eq!(rect.bottom, 700);
                } else {
                    assert_eq!(rect.top, 100);
                }
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn native_sizing_callback_constrains_a_real_window_and_updates_its_ratio() {
        use windows::{
            core::w,
            Win32::{
                Foundation::{LPARAM, RECT, WPARAM},
                UI::WindowsAndMessaging::*,
            },
        };
        unsafe {
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("PiP resize fixture"),
                WS_POPUP | WS_THICKFRAME,
                0,
                0,
                640,
                480,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            for ratio in [16.0 / 9.0, 9.0 / 16.0] {
                proportional_resize::install(hwnd, ratio).unwrap();
                let mut outer = RECT::default();
                let mut client = RECT::default();
                GetWindowRect(hwnd, &mut outer).unwrap();
                GetClientRect(hwnd, &mut client).unwrap();
                let frame = (
                    outer.right - outer.left - client.right,
                    outer.bottom - outer.top - client.bottom,
                );
                let mut requested = RECT {
                    left: 20,
                    top: 20,
                    right: 900,
                    bottom: 500,
                };
                SendMessageW(
                    hwnd,
                    WM_SIZING,
                    WPARAM(WMSZ_BOTTOMRIGHT as usize),
                    LPARAM(&mut requested as *mut RECT as isize),
                );
                let width = (requested.right - requested.left - frame.0) as f64;
                let height = (requested.bottom - requested.top - frame.1) as f64;
                assert!((height - width / ratio).abs() <= 1.0);
            }
            DestroyWindow(hwnd).unwrap();
        }
    }
}
