//! Bounded loopback IPC to an opt-in elevated input helper for UIPI-protected windows.

#[cfg(windows)]
mod win {
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpStream};
    use std::os::windows::ffi::OsStrExt;
    use std::sync::{LazyLock, Mutex};
    use std::time::Duration;
    use subtle::ConstantTimeEq;
    use tokio::net::TcpListener;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::Security::{
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    };
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcessToken, WaitForSingleObject,
    };
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT};
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
        SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    const MAX_INPUT_BATCH: usize = 64;
    const OP_SEND_INPUTS: u8 = 1;
    const OP_SHUTDOWN: u8 = 0xFF;

    struct ComApartment;
    impl ComApartment {
        fn new() -> Result<Self, String> {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }
                .map_err(|e| e.to_string())?;
            Ok(Self)
        }
    }
    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }

    pub struct HelperProcess(usize);
    impl HelperProcess {
        pub fn exited(&self) -> bool {
            unsafe { WaitForSingleObject(HANDLE(self.0 as _), 0) == WAIT_OBJECT_0 }
        }
    }
    impl Drop for HelperProcess {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(HANDLE(self.0 as _));
            }
        }
    }

    struct HelperConnection {
        stream: TcpStream,
        process: HelperProcess,
    }

    static HELPER: LazyLock<Mutex<Option<HelperConnection>>> = LazyLock::new(|| Mutex::new(None));
    static LAUNCH_LOCK: LazyLock<tokio::sync::Mutex<()>> =
        LazyLock::new(|| tokio::sync::Mutex::new(()));

    pub fn is_current_process_elevated() -> bool {
        const SECURITY_MANDATORY_HIGH_RID: u32 = 0x3000;
        unsafe {
            let mut token = HANDLE::default();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
                return false;
            }
            let mut len = 0u32;
            let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut len);
            if len == 0 || len > 4096 {
                let _ = CloseHandle(token);
                return false;
            }
            let mut buf = vec![0u8; len as usize];
            let ok = GetTokenInformation(
                token,
                TokenIntegrityLevel,
                Some(buf.as_mut_ptr() as *mut _),
                len,
                &mut len,
            )
            .is_ok();
            let _ = CloseHandle(token);
            if !ok {
                return false;
            }
            let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
            if label.Label.Sid.is_invalid() {
                return false;
            }
            let count = GetSidSubAuthorityCount(label.Label.Sid);
            if count.is_null() || *count == 0 {
                return false;
            }
            let rid = GetSidSubAuthority(label.Label.Sid, u32::from(*count - 1));
            !rid.is_null() && *rid >= SECURITY_MANDATORY_HIGH_RID
        }
    }

    pub fn is_elevation_ready() -> bool {
        if is_current_process_elevated() {
            return true;
        }
        let Ok(mut guard) = HELPER.lock() else {
            return false;
        };
        if let Some(conn) = guard.as_ref() {
            if !conn.process.exited() {
                return true;
            }
        }
        *guard = None;
        false
    }

    fn elevate_helper(port: u16, token: &str) -> Result<HelperProcess, String> {
        let _apartment = ComApartment::new()?;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let path: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
        let parameters: Vec<u16> = format!("--p2sharer-rc-helper {port} {token}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
            lpVerb: w!("runas"),
            lpFile: PCWSTR(path.as_ptr()),
            lpParameters: PCWSTR(parameters.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };
        unsafe {
            ShellExecuteExW(&mut info).map_err(|e| {
                format!("Remote control administrator access requires Windows consent: {e}")
            })?;
        }
        if info.hProcess.is_invalid() {
            return Err("Windows did not return an elevated helper process handle".into());
        }
        Ok(HelperProcess(info.hProcess.0 as usize))
    }

    pub async fn ensure_elevation_ready() -> Result<bool, String> {
        if is_elevation_ready() {
            return Ok(true);
        }
        let _guard = LAUNCH_LOCK.lock().await;
        if is_elevation_ready() {
            return Ok(true);
        }

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let mut entropy = [0u8; 32];
        getrandom::getrandom(&mut entropy).map_err(|e| e.to_string())?;
        let token: String = entropy.iter().map(|b| format!("{b:02x}")).collect();
        let launch_token = token.clone();

        crate::logger::log_msg(
            "INFO",
            "remote_control",
            "Requesting Windows administrator consent for remote control helper",
        );

        let process =
            tokio::task::spawn_blocking(move || elevate_helper(port, &launch_token))
                .await
                .map_err(|e| e.to_string())??;

        let stream = tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
                let _ = stream.set_nodelay(true);
                let mut auth = [0u8; 64];
                if matches!(
                    tokio::time::timeout(
                        Duration::from_secs(2),
                        tokio::io::AsyncReadExt::read_exact(&mut stream, &mut auth)
                    )
                    .await,
                    Ok(Ok(_))
                ) && bool::from(auth.ct_eq(token.as_bytes()))
                {
                    return Ok::<_, String>(stream);
                }
            }
        })
        .await
        .map_err(|_| "Elevated remote control helper did not connect in time")??;

        let std_stream = stream.into_std().map_err(|e| e.to_string())?;
        std_stream
            .set_nonblocking(false)
            .map_err(|e| e.to_string())?;
        let _ = std_stream.set_read_timeout(Some(Duration::from_millis(500)));
        let _ = std_stream.set_write_timeout(Some(Duration::from_millis(500)));
        let _ = std_stream.set_nodelay(true);

        if let Ok(mut guard) = HELPER.lock() {
            *guard = Some(HelperConnection {
                stream: std_stream,
                process,
            });
        }
        crate::logger::log_msg(
            "INFO",
            "remote_control",
            "Elevated remote control helper connected cleanly",
        );
        Ok(true)
    }

    /// Dispatches Win32 `INPUT` structs via the elevated helper when active.
    /// Returns `None` if no elevated helper is connected, `Some(true/false)` if handled.
    pub fn send_inputs_via_helper(inputs: &[INPUT]) -> Option<bool> {
        if inputs.is_empty() {
            return Some(true);
        }
        let mut guard = HELPER.lock().ok()?;
        let conn = guard.as_mut()?;
        if conn.process.exited() {
            *guard = None;
            return None;
        }
        let item_size = std::mem::size_of::<INPUT>();
        let count = inputs.len().min(MAX_INPUT_BATCH);
        let payload_len = count * item_size;
        let mut buf = Vec::with_capacity(3 + payload_len);
        buf.push(OP_SEND_INPUTS);
        buf.extend_from_slice(&(count as u16).to_le_bytes());
        let raw_bytes =
            unsafe { std::slice::from_raw_parts(inputs.as_ptr() as *const u8, payload_len) };
        buf.extend_from_slice(raw_bytes);
        if conn.stream.write_all(&buf).is_err() {
            *guard = None;
            return None;
        }
        let mut ack = [0u8; 1];
        if conn.stream.read_exact(&mut ack).is_err() {
            *guard = None;
            return None;
        }
        Some(ack[0] == 1)
    }

    pub fn shutdown_helper() {
        if let Ok(mut guard) = HELPER.lock() {
            if let Some(mut conn) = guard.take() {
                let _ = conn.stream.write_all(&[OP_SHUTDOWN]);
                let _ = conn.stream.shutdown(Shutdown::Both);
            }
        }
    }

    pub fn run_helper_if_requested() -> bool {
        let args: Vec<String> = std::env::args().collect();
        if args.get(1).is_none_or(|s| s != "--p2sharer-rc-helper") {
            return false;
        }
        if args.len() == 4
            && args[3].len() == 64
            && args[3].bytes().all(|b| b.is_ascii_hexdigit())
        {
            if let Ok(port) = args[2].parse::<u16>() {
                if port != 0 {
                    crate::logger::init_logger();
                    if let Err(error) = run_helper(port, &args[3]) {
                        crate::logger::log_msg("ERROR", "remote_control_helper", &error);
                    }
                }
            }
        }
        true
    }

    fn run_helper(port: u16, token: &str) -> Result<(), String> {
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
        let _ = stream.set_nodelay(true);
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        stream
            .write_all(token.as_bytes())
            .map_err(|e| e.to_string())?;

        let item_size = std::mem::size_of::<INPUT>();
        let mut inputs: Vec<INPUT> = vec![INPUT::default(); MAX_INPUT_BATCH];
        loop {
            let mut op = [0u8; 1];
            if stream.read_exact(&mut op).is_err() || op[0] == OP_SHUTDOWN {
                break;
            }
            if op[0] != OP_SEND_INPUTS {
                break;
            }
            let mut count_bytes = [0u8; 2];
            if stream.read_exact(&mut count_bytes).is_err() {
                break;
            }
            let count = usize::from(u16::from_le_bytes(count_bytes));
            if count == 0 || count > MAX_INPUT_BATCH {
                break;
            }
            let byte_len = count * item_size;
            let raw_buf =
                unsafe { std::slice::from_raw_parts_mut(inputs.as_mut_ptr() as *mut u8, byte_len) };
            if stream.read_exact(raw_buf).is_err() {
                break;
            }
            let sent = unsafe { SendInput(&inputs[..count], item_size as i32) > 0 };
            if stream.write_all(&[u8::from(sent)]).is_err() {
                break;
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use win::{
    ensure_elevation_ready, is_current_process_elevated, is_elevation_ready,
    run_helper_if_requested, send_inputs_via_helper, shutdown_helper,
};

#[cfg(not(windows))]
pub fn is_current_process_elevated() -> bool {
    false
}

#[cfg(not(windows))]
pub fn is_elevation_ready() -> bool {
    false
}

#[cfg(not(windows))]
pub async fn ensure_elevation_ready() -> Result<bool, String> {
    Err("Remote control administrator elevation requires Windows".into())
}

#[cfg(not(windows))]
pub fn run_helper_if_requested() -> bool {
    false
}

#[cfg(not(windows))]
pub fn shutdown_helper() {}
