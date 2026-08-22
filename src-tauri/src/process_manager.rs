use serde::{Deserialize, Serialize};
use sysinfo::System;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProcessItem {
    pub pid: u32,
    pub name: String,
    pub exe_path: Option<String>,
    pub window_title: Option<String>,
    pub is_likely_chat_or_voice: bool,
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

    let mut results = Vec::new();
    let mut seen_pids = std::collections::HashSet::new();

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
            if seen_pids.insert(pid_u32) {
                let exe_path = process.exe().map(|p| p.to_string_lossy().to_string());
                results.push(ProcessItem {
                    pid: pid_u32,
                    name,
                    exe_path,
                    window_title: effective_title,
                    is_likely_chat_or_voice: is_voice,
                });
            }
        }
    }

    // Sort voice apps first, then alphabetically
    results.sort_by(|a, b| {
        b.is_likely_chat_or_voice
            .cmp(&a.is_likely_chat_or_voice)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    results
}
