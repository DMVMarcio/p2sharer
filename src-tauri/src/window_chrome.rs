/// Delegate caption context menus to Windows, including native command states,
/// localization, positioning and the existing Tauri window message procedure.
#[tauri::command]
pub fn show_window_menu(window: tauri::Window) -> Result<(), String> {
    if window.label() != "main" { return Err("Only the main window exposes the caption menu".into()); }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, PostMessageW, HTCAPTION, WM_NCRBUTTONUP};
        let hwnd = HWND(window.hwnd().map_err(|error| error.to_string())?.0 as *mut std::ffi::c_void);
        let mut point = POINT::default();
        unsafe {
            GetCursorPos(&mut point).map_err(|error| error.to_string())?;
            let position = (point.x as u16 as u32) | ((point.y as u16 as u32) << 16);
            PostMessageW(hwnd, WM_NCRBUTTONUP, WPARAM(HTCAPTION as usize), LPARAM(position as isize))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}
