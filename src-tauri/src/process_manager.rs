use serde::{Deserialize, Serialize};
use sysinfo::System;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProcessItem {
    pub pid: u32,
    pub name: String,
    pub exe_path: Option<String>,
    pub window_title: Option<String>,
    pub is_likely_chat_or_voice: bool,
    #[serde(default)]
    pub icon_base64: Option<String>,
}

#[cfg(windows)]
unsafe fn extract_icon_as_png_base64(exe_path: Option<&str>) -> Option<String> {
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON};
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, DestroyIcon, ICONINFO};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW,
        BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::core::PCWSTR;
    use image::{RgbaImage, ImageFormat};
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;

    let path = exe_path?;
    let path_utf16: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut sfi = SHFILEINFOW::default();
    let res = SHGetFileInfoW(
        PCWSTR(path_utf16.as_ptr()),
        windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0),
        Some(&mut sfi),
        std::mem::size_of::<SHFILEINFOW>() as u32,
        SHGFI_ICON | SHGFI_SMALLICON,
    );

    if res == 0 || sfi.hIcon.is_invalid() {
        return None;
    }
    let hicon = sfi.hIcon;

    let mut icon_info = ICONINFO::default();
    if GetIconInfo(hicon, &mut icon_info).is_err() {
        let _ = DestroyIcon(hicon);
        return None;
    }

    let hbm_color = icon_info.hbmColor;
    let hbm_mask = icon_info.hbmMask;

    let hdc = CreateCompatibleDC(None);
    if hdc.is_invalid() {
        if !hbm_color.is_invalid() { let _ = DeleteObject(hbm_color); }
        if !hbm_mask.is_invalid() { let _ = DeleteObject(hbm_mask); }
        let _ = DestroyIcon(hicon);
        return None;
    }

    let mut bmp = BITMAP::default();
    let get_obj_res = GetObjectW(
        hbm_color,
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bmp as *mut _ as *mut _),
    );

    if get_obj_res == 0 || bmp.bmWidth <= 0 || bmp.bmHeight <= 0 {
        let _ = DeleteDC(hdc);
        if !hbm_color.is_invalid() { let _ = DeleteObject(hbm_color); }
        if !hbm_mask.is_invalid() { let _ = DeleteObject(hbm_mask); }
        let _ = DestroyIcon(hicon);
        return None;
    }

    let width = bmp.bmWidth as u32;
    let height = bmp.bmHeight as u32;

    let mut bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32), // top-down DIB
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };

    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let lines = GetDIBits(
        hdc,
        hbm_color,
        0,
        height,
        Some(pixels.as_mut_ptr() as *mut _),
        &mut bi,
        DIB_RGB_COLORS,
    );

    let _ = DeleteDC(hdc);
    if !hbm_color.is_invalid() { let _ = DeleteObject(hbm_color); }
    if !hbm_mask.is_invalid() { let _ = DeleteObject(hbm_mask); }
    let _ = DestroyIcon(hicon);

    if lines == 0 {
        return None;
    }

    // Windows GDI returns BGRA, convert to RGBA
    for chunk in pixels.chunks_exact_mut(4) {
        chunk.swap(0, 2);
    }

    let has_non_zero_alpha = pixels.chunks_exact(4).any(|c| c[3] > 0);
    if !has_non_zero_alpha {
        for chunk in pixels.chunks_exact_mut(4) {
            chunk[3] = 255;
        }
    }

    let img = RgbaImage::from_raw(width, height, pixels)?;
    let mut png_bytes = std::io::Cursor::new(Vec::new());
    img.write_to(&mut png_bytes, ImageFormat::Png).ok()?;

    Some(format!("data:image/png;base64,{}", BASE64.encode(png_bytes.into_inner())))
}

#[cfg(windows)]
use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
};

#[cfg(windows)]
struct WindowInfo {
    pid: u32,
    title: String,
}

#[cfg(windows)]
unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }

    let mut title_buf = [0u16; 512];
    let len = GetWindowTextW(hwnd, &mut title_buf);
    if len == 0 {
        return BOOL(1);
    }

    let title = String::from_utf16_lossy(&title_buf[..len as usize]);
    let title_trim = title.trim();
    if title_trim.is_empty()
        || title_trim == "Program Manager"
        || title_trim == "Windows Input Experience"
        || title_trim == "Settings"
    {
        return BOOL(1);
    }

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));

    let window_list = &mut *(lparam.0 as *mut Vec<WindowInfo>);
    window_list.push(WindowInfo {
        pid,
        title: title_trim.to_string(),
    });

    BOOL(1)
}

#[tauri::command]
pub fn list_audio_processes() -> Vec<ProcessItem> {
    let mut sys = System::new_all();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    #[cfg(windows)]
    let mut window_list: Vec<WindowInfo> = Vec::new();
    #[cfg(windows)]
    unsafe {
        let lparam = LPARAM(&mut window_list as *mut _ as isize);
        let _ = EnumWindows(Some(enum_windows_callback), lparam);
    }

    // Group processes by executable name so users see 1 clean entry per application
    // rather than multiple PID entries for multi-process apps (e.g. Discord, Chrome, Steam)
    let mut app_map: std::collections::HashMap<String, ProcessItem> = std::collections::HashMap::new();
    let mut icon_cache: std::collections::HashMap<String, Option<String>> = std::collections::HashMap::new();

    // Known communication / voice apps to highlight for easy 1-click exclusion
    let voice_keywords = [
        "discord",
        "teamspeak",
        "telegram",
        "whatsapp",
        "slack",
        "zoom",
        "skype",
        "teams",
        "steamwebhelper",
        "viber",
        "guilded",
    ];

    for (pid, process) in sys.processes() {
        let pid_u32 = pid.as_u32();
        let name = process.name().to_string_lossy().to_string();
        let name_lower = name.to_lowercase();

        #[cfg(windows)]
        let window_title = window_list
            .iter()
            .find(|w| w.pid == pid_u32)
            .map(|w| w.title.clone());

        #[cfg(not(windows))]
        let window_title: Option<String> = None;

        let self_pid = std::process::id();
        let is_self = pid_u32 == self_pid || name_lower.contains("p2sharer");
        let is_voice = is_self || voice_keywords.iter().any(|&k| name_lower.contains(k));

        let effective_title = if is_self {
            Some("p2sharer (Este Aplicativo)".to_string())
        } else {
            window_title
        };

        // Filter to interesting processes (either has a window or is a known audio/voice app)
        if effective_title.is_some() || is_voice {
            let exe_path = process.exe().map(|p| p.to_string_lossy().to_string());

            #[cfg(windows)]
            let icon_base64 = icon_cache
                .entry(name_lower.clone())
                .or_insert_with(|| unsafe { extract_icon_as_png_base64(exe_path.as_deref()) })
                .clone();

            #[cfg(not(windows))]
            let icon_base64: Option<String> = None;

            let item = ProcessItem {
                pid: pid_u32,
                name: name.clone(),
                exe_path,
                window_title: effective_title,
                is_likely_chat_or_voice: is_voice,
                icon_base64,
            };

            // If already present, prefer the entry with a window title
            match app_map.entry(name_lower) {
                std::collections::hash_map::Entry::Vacant(v) => {
                    v.insert(item);
                }
                std::collections::hash_map::Entry::Occupied(mut o) => {
                    if o.get().window_title.is_none() && item.window_title.is_some() {
                        o.insert(item);
                    }
                }
            }
        }
    }

    let mut results: Vec<ProcessItem> = app_map.into_values().collect();

    // Sort voice apps first, then alphabetically
    results.sort_by(|a, b| {
        b.is_likely_chat_or_voice
            .cmp(&a.is_likely_chat_or_voice)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    results
}

#[cfg(windows)]
static HELD_JOB_OBJECT: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
#[cfg(windows)]
static HELD_SINGLE_INSTANCE_MUTEX: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

#[cfg(windows)]
pub fn setup_job_object_for_clean_child_teardown() {
    unsafe {
        use windows::Win32::System::JobObjects::{
            CreateJobObjectW, SetInformationJobObject, AssignProcessToJobObject,
            JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows::Win32::System::Threading::GetCurrentProcess;

        if let Ok(job) = CreateJobObjectW(None, None) {
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let res = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if res.is_ok() {
                let assign_res = AssignProcessToJobObject(job, GetCurrentProcess());
                if assign_res.is_ok() {
                    HELD_JOB_OBJECT.store(job.0 as isize, std::sync::atomic::Ordering::SeqCst);
                    println!("[Process Manager] Bound P2Sharer to Windows Job Object with KILL_ON_JOB_CLOSE.");
                }
            }
        }
    }
}

#[cfg(not(windows))]
pub fn setup_job_object_for_clean_child_teardown() {}

#[cfg(windows)]
pub fn check_or_create_single_instance_mutex() -> bool {
    unsafe {
        use windows::Win32::Foundation::GetLastError;
        use windows::Win32::System::Threading::CreateMutexW;
        use windows::core::w;

        let mutex_name = w!("Local\\P2SharerSingleInstanceMutex");
        if let Ok(handle) = CreateMutexW(None, true, mutex_name) {
            // ERROR_ALREADY_EXISTS = 183
            if GetLastError().0 == 183 {
                return false;
            }
            HELD_SINGLE_INSTANCE_MUTEX.store(handle.0 as isize, std::sync::atomic::Ordering::SeqCst);
            return true;
        }
        true
    }
}

#[cfg(not(windows))]
pub fn check_or_create_single_instance_mutex() -> bool {
    true
}

#[cfg(windows)]
pub fn focus_existing_instance_window() {
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{
            FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE,
        };
        use windows::core::w;

        let title = w!("P2Sharer - Compartilhamento P2P de Tela e Áudio");
        if let Ok(hwnd) = FindWindowW(None, title) {
            if !hwnd.is_invalid() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                let _ = SetForegroundWindow(hwnd);
            }
        }
    }
}

#[cfg(not(windows))]
pub fn focus_existing_instance_window() {}

