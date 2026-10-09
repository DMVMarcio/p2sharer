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
pub fn setup_job_object_with_name(name: Option<&str>) -> Result<(), String> {
    unsafe {
        use windows::Win32::System::JobObjects::{
            CreateJobObjectW, SetInformationJobObject, AssignProcessToJobObject,
            JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows::Win32::System::Threading::GetCurrentProcess;
        use windows::core::{HSTRING, PCWSTR};

        let hname = name.map(HSTRING::from);
        let pcwstr = match &hname {
            Some(h) => PCWSTR(h.as_ptr()),
            None => PCWSTR::null(),
        };

        let job = CreateJobObjectW(None, pcwstr)
            .map_err(|e| format!("CreateJobObjectW failed: {e}"))?;

        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let _ = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );

        let _ = AssignProcessToJobObject(job, GetCurrentProcess());
        HELD_JOB_OBJECT.store(job.0 as isize, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}

#[cfg(windows)]
pub fn setup_job_object_for_clean_child_teardown() {
    let is_fixture = std::env::var("P2SHARER_JOB_TEST_ROLE").is_ok();
    let name = if is_fixture {
        None
    } else {
        Some("Local\\P2SharerSharedJobObject")
    };
    if let Err(e) = setup_job_object_with_name(name) {
        crate::logger::log_msg("WARN", "process_manager", &format!("Could not bind job object: {e}"));
    } else {
        println!("[Process Manager] Bound P2Sharer to Windows Job Object with KILL_ON_JOB_CLOSE.");
    }
}

#[cfg(not(windows))]
pub fn setup_job_object_for_clean_child_teardown() {}

#[cfg(not(windows))]
pub fn setup_job_object_with_name(_name: Option<&str>) -> Result<(), String> { Ok(()) }

/// Let the updater's installer outlive the app without releasing existing media children.
#[cfg(windows)]
pub fn set_update_installer_breakaway(enabled: bool) -> Result<(), String> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        QueryInformationJobObject, SetInformationJobObject, JobObjectExtendedLimitInformation,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };
    let handle = HELD_JOB_OBJECT.load(std::sync::atomic::Ordering::SeqCst);
    if handle == 0 { return Ok(()); }
    let job = HANDLE(handle as *mut std::ffi::c_void);
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    unsafe {
        QueryInformationJobObject(job, JobObjectExtendedLimitInformation,
            &mut info as *mut _ as *mut std::ffi::c_void,
            std::mem::size_of_val(&info) as u32, None)
            .map_err(|error| format!("Could not read updater process policy: {error}"))?;
        if enabled {
            info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
        } else {
            info.BasicLimitInformation.LimitFlags &= !JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
        }
        SetInformationJobObject(job, JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&info) as u32)
            .map_err(|error| format!("Could not set updater process policy: {error}"))?;
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set_update_installer_breakaway(_enabled: bool) -> Result<(), String> { Ok(()) }

#[cfg(all(test, windows))]
mod updater_job_tests {
    use super::*;
    use std::{io::Write, os::windows::io::AsRawHandle, process::{Command, Stdio}};
    use windows::Win32::{Foundation::{BOOL, HANDLE}, System::JobObjects::{
        IsProcessInJob, QueryInformationJobObject, JobObjectExtendedLimitInformation,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    }};

    #[test]
    fn installer_breakaway_preserves_normal_child_teardown_and_can_be_cancelled() {
        // Assign only an isolated fixture process, never the parallel test runner.
        let result = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "process_manager::updater_job_tests::isolated_job_worker", "--ignored", "--nocapture"])
            .env("P2SHARER_JOB_TEST_ROLE", "worker").output().unwrap();
        assert!(result.status.success(), "{}\n{}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
        assert!(String::from_utf8_lossy(&result.stdout).contains("UPDATER_JOB_POLICY_VERIFIED"));
    }

    #[test]
    #[ignore = "Internal process fixture; invoked by the automatic updater containment regression"]
    fn isolated_job_worker() {
        assert_eq!(std::env::var("P2SHARER_JOB_TEST_ROLE").unwrap(), "worker");
        setup_job_object_for_clean_child_teardown();
        let raw_job = HELD_JOB_OBJECT.load(std::sync::atomic::Ordering::SeqCst);
        assert_ne!(raw_job, 0, "The fixture must exercise a real Windows job");
        let job = HANDLE(raw_job as *mut std::ffi::c_void);
        let probe = |expected: bool| {
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "process_manager::updater_job_tests::child_waits_for_probe", "--ignored"])
                .env("P2SHARER_JOB_TEST_ROLE", "child")
                .stdin(Stdio::piped()).stdout(Stdio::null()).spawn().unwrap();
            let mut associated = BOOL(0);
            unsafe { IsProcessInJob(HANDLE(child.as_raw_handle()), job, &mut associated).unwrap(); }
            // Release and reap the child before asserting, including on a failed assertion.
            child.stdin.take().unwrap().write_all(b"continue\n").unwrap();
            assert!(child.wait().unwrap().success());
            assert_eq!(associated.as_bool(), expected);
        };
        probe(true);
        set_update_installer_breakaway(true).unwrap();
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(job, JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of_val(&info) as u32, None).unwrap();
        }
        assert!(info.BasicLimitInformation.LimitFlags.contains(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE));
        probe(false);
        set_update_installer_breakaway(false).unwrap();
        probe(true);
        println!("UPDATER_JOB_POLICY_VERIFIED");
    }

    #[test]
    #[ignore = "Internal child fixture; invoked by the automatic updater containment regression"]
    fn child_waits_for_probe() {
        assert_eq!(std::env::var("P2SHARER_JOB_TEST_ROLE").unwrap(), "child");
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "continue");
    }

    #[test]
    fn concurrent_instances_share_named_job_and_teardown_only_on_last_close() {
        let unique_id = format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let unique_job_name = format!("Local\\P2SharerTestJob-{unique_id}");
        let test_dir = std::env::temp_dir().join(format!("p2sharer_job_test_{unique_id}"));
        std::fs::create_dir_all(&test_dir).unwrap();

        // 1. Spawn Worker 1
        let mut worker1 = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "process_manager::updater_job_tests::file_coordinated_worker", "--ignored"])
            .env("P2SHARER_JOB_TEST_ROLE", "worker_1")
            .env("P2SHARER_JOB_TEST_NAME", &unique_job_name)
            .env("P2SHARER_JOB_TEST_DIR", &test_dir)
            .spawn()
            .unwrap();

        // Wait for Child PID written by Worker 1
        let child_pid_file = test_dir.join("child.pid");
        let start = std::time::Instant::now();
        let child_pid = loop {
            if let Ok(content) = std::fs::read_to_string(&child_pid_file) {
                if let Ok(pid) = content.trim().parse::<u32>() {
                    break pid;
                }
            }
            if start.elapsed().as_secs() > 10 {
                panic!("Timeout waiting for worker 1 to spawn child");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };

        // 2. Spawn Worker 2
        let mut worker2 = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "process_manager::updater_job_tests::file_coordinated_worker", "--ignored"])
            .env("P2SHARER_JOB_TEST_ROLE", "worker_2")
            .env("P2SHARER_JOB_TEST_NAME", &unique_job_name)
            .env("P2SHARER_JOB_TEST_DIR", &test_dir)
            .spawn()
            .unwrap();

        // Wait for Worker 2 ready file
        let w2_ready_file = test_dir.join("worker_2.ready");
        let start = std::time::Instant::now();
        loop {
            if w2_ready_file.exists() {
                break;
            }
            if start.elapsed().as_secs() > 10 {
                panic!("Timeout waiting for worker 2 ready");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        // Open child process handle to observe termination
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};
        use windows::Win32::Foundation::{WAIT_TIMEOUT, WAIT_OBJECT_0};
        let child_handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, child_pid).unwrap() };

        // 3. Signal Worker 1 to exit (Primary instance closes!)
        std::fs::write(test_dir.join("worker_1.exit"), b"1").unwrap();
        assert!(worker1.wait().unwrap().success());

        // Verify Child is STILL ALIVE (Worker 2 is still holding the job handle!)
        let wait_res = unsafe { WaitForSingleObject(child_handle, 500) };
        assert_eq!(wait_res, WAIT_TIMEOUT, "Child process should remain alive while Worker 2 holds job handle");

        // 4. Signal Worker 2 to exit (Last instance closes!)
        std::fs::write(test_dir.join("worker_2.exit"), b"1").unwrap();
        assert!(worker2.wait().unwrap().success());

        // Verify Child is now KILLED by Windows Job Object teardown!
        let wait_res2 = unsafe { WaitForSingleObject(child_handle, 5000) };
        assert_eq!(wait_res2, WAIT_OBJECT_0, "Child process should be terminated when last job handle closes");

        let _ = std::fs::remove_dir_all(&test_dir);
    }

    #[test]
    #[ignore = "Internal worker fixture; invoked by concurrent job regression test"]
    fn file_coordinated_worker() {
        let role = std::env::var("P2SHARER_JOB_TEST_ROLE").unwrap();
        let job_name = std::env::var("P2SHARER_JOB_TEST_NAME").unwrap();
        let test_dir = std::path::PathBuf::from(std::env::var("P2SHARER_JOB_TEST_DIR").unwrap());

        setup_job_object_with_name(Some(&job_name)).unwrap();

        let mut child_proc = None;
        if role == "worker_1" {
            let child = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "process_manager::updater_job_tests::child_runs_indefinitely", "--ignored"])
                .env("P2SHARER_JOB_TEST_ROLE", "child")
                .spawn()
                .unwrap();
            std::fs::write(test_dir.join("child.pid"), child.id().to_string()).unwrap();
            child_proc = Some(child);
        } else if role == "worker_2" {
            std::fs::write(test_dir.join("worker_2.ready"), b"1").unwrap();
        }

        let exit_file = test_dir.join(format!("{role}.exit"));
        while !exit_file.exists() {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        std::mem::forget(child_proc);
    }

    #[test]
    #[ignore = "Internal child fixture; invoked by concurrent job regression test"]
    fn child_runs_indefinitely() {
        assert_eq!(std::env::var("P2SHARER_JOB_TEST_ROLE").unwrap(), "child");
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
}

