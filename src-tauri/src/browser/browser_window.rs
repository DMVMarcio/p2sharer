//! Confine capture windows before Windows applies site fullscreen or DPI repositioning.
use windows::{core::w, Win32::{
    Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM},
    UI::WindowsAndMessaging::{CallWindowProcW, DefWindowProcW, GetPropW, RemovePropW, SetPropW,
        GetWindowLongPtrW, SetWindowLongPtrW, GWLP_WNDPROC, WNDPROC, GetSystemMetrics, GetWindowRect,
        SetWindowPos, WINDOWPOS, SM_XVIRTUALSCREEN, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER, WM_NCDESTROY, WM_WINDOWPOSCHANGING},
}};

const PROPERTY: windows::core::PCWSTR = w!("P2Sharer.BrowserCapture.Bounds");
#[derive(Clone, Copy)]
struct Bounds { left: i32, width: i32, height: i32 }
#[derive(Clone, Copy)]
struct Guard { bounds: Bounds, previous: WNDPROC }
fn constrain(position: &mut WINDOWPOS, bounds: Bounds) {
    position.x = bounds.left; position.y = 0;
    position.cx = bounds.width; position.cy = bounds.height;
    position.flags = (position.flags & !(SWP_NOMOVE | SWP_NOSIZE)) | SWP_NOACTIVATE | SWP_NOZORDER;
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let data = GetPropW(hwnd, PROPERTY).0 as *const Guard;
    if data.is_null() { return DefWindowProcW(hwnd, message, wp, lp); }
    // Copy before delegation: the previous proc may deliver nested window messages.
    let guard = *data;
    let result = CallWindowProcW(guard.previous, hwnd, message, wp, lp);
    if message == WM_WINDOWPOSCHANGING && lp.0 != 0 {
        constrain(&mut *(lp.0 as *mut WINDOWPOS), guard.bounds);
    }
    if message == WM_NCDESTROY {
        if let Ok(data) = RemovePropW(hwnd, PROPERTY) {
            if !data.0.is_null() { drop(Box::from_raw(data.0 as *mut Guard)); }
        }
    }
    result
}

/// Preserve the runtime's original procedure; own state until native destruction.
/// Called only on the owning UI apartment, without Common Controls version dependencies.
pub unsafe fn install(hwnd: HWND, width: u32) -> Result<(), String> {
    let bounds = Bounds { left: GetSystemMetrics(SM_XVIRTUALSCREEN).saturating_sub(width as i32 + 128),
        width: width as i32, height: (width * 9 / 16) as i32 };
    let data = GetPropW(hwnd, PROPERTY).0 as *mut Guard;
    if !data.is_null() {
        (*data).bounds = bounds;
    } else {
        let previous = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
        if previous == 0 { return Err("Browser capture window closed".into()); }
        let data = Box::into_raw(Box::new(Guard { bounds, previous: Some(std::mem::transmute::<isize,
            unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT>(previous)) }));
        if let Err(e) = SetPropW(hwnd, PROPERTY, HANDLE(data.cast())) { drop(Box::from_raw(data)); return Err(e.to_string()); }
        if SetWindowLongPtrW(hwnd, GWLP_WNDPROC, window_proc as *const () as isize) == 0 {
            let _ = RemovePropW(hwnd, PROPERTY); drop(Box::from_raw(data));
            return Err("Failed to confine browser capture window".into());
        }
    }
    let mut rect = Default::default();
    GetWindowRect(hwnd, &mut rect).map_err(|e| e.to_string())?;
    if rect.left != bounds.left || rect.top != 0 || rect.right - rect.left != bounds.width || rect.bottom - rect.top != bounds.height {
        SetWindowPos(hwnd, HWND::default(), bounds.left, 0, bounds.width, bounds.height, SWP_NOACTIVATE | SWP_NOZORDER).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_window_rejects_visible_fullscreen_position_and_topmost_promotion() {
        use windows::{core::w, Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow,
            GetWindowLongPtrW, IsWindowVisible, GWL_EXSTYLE, HWND_TOPMOST, SET_WINDOW_POS_FLAGS,
            WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP}};
        struct Fixture(HWND);
        impl Drop for Fixture { fn drop(&mut self) { unsafe { let _ = DestroyWindow(self.0); } } }
        unsafe {
            let window = Fixture(CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, w!("STATIC"), None,
                WS_POPUP, 0, 0, 1280, 720, None, None, None, None).unwrap());
            install(window.0, 1280).unwrap();
            let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
            SetWindowPos(window.0, HWND_TOPMOST, left, 0, 3840, 2160, SET_WINDOW_POS_FLAGS(0)).unwrap();
            let mut rect = Default::default(); GetWindowRect(window.0, &mut rect).unwrap();
            assert!(rect.right < left); assert_eq!((rect.right - rect.left, rect.bottom - rect.top), (1280, 720));
            assert_eq!(GetWindowLongPtrW(window.0, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0, 0);
            assert!(!IsWindowVisible(window.0).as_bool());
            install(window.0, 1920).unwrap(); GetWindowRect(window.0, &mut rect).unwrap();
            assert!(rect.right < left); assert_eq!((rect.right - rect.left, rect.bottom - rect.top), (1920, 1080));
        }
    }
    #[test]
    fn fullscreen_and_dpi_moves_remain_outside_the_virtual_desktop() {
        for (left, width) in [(0, 1280), (-3840, 1920)] {
            let bounds = Bounds { left: left - width - 128, width, height: width * 9 / 16 };
            let mut request = WINDOWPOS { x: 0, y: 0, cx: 3840, cy: 2160, flags: SWP_NOMOVE | SWP_NOSIZE, ..Default::default() };
            constrain(&mut request, bounds);
            assert!(request.x + request.cx < left);
            assert_eq!((request.cx, request.cy), (width, width * 9 / 16));
            assert!(request.flags.contains(SWP_NOACTIVATE | SWP_NOZORDER));
            assert_eq!((request.flags & (SWP_NOMOVE | SWP_NOSIZE)).0, 0);
        }
    }
}
