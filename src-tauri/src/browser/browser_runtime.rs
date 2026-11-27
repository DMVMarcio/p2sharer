//! Browser rendering preferences are isolated from the shell and capture encoders.
pub fn arguments(inherited: &str, hardware_acceleration: bool) -> String {
    let software = if hardware_acceleration { "" } else {
        " --disable-gpu --disable-gpu-compositing --disable-gpu-rasterization --disable-accelerated-video-decode --disable-accelerated-video-encode --disable-features=WebRtcHardwareVideoEncoding,WebRtcHardwareVideoDecoding,AcceleratedVideoEncoder,AcceleratedVideoDecoder"
    };
    format!("{inherited} --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-direct-composition-video-overlays --disable-direct-composition-sw-video-overlays{software}")
}

#[cfg(windows)]
pub async fn wait_for_exit(pid: u32) -> Result<(), String> {
    // Passive wait: restarting never terminates the shell or kills a browser process.
    tokio::task::spawn_blocking(move || unsafe {
        use windows::Win32::{Foundation::{CloseHandle, WAIT_OBJECT_0}, System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE}};
        let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) else { return Ok(()); };
        let result = WaitForSingleObject(handle, 6000);
        let _ = CloseHandle(handle);
        if result == WAIT_OBJECT_0 { Ok(()) } else { Err("Browser restart timed out".into()) }
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_browser_hardware_preferences_preserve_shell_arguments_and_disable_only_browser_rendering() {
        let inherited = "--enable-gpu-rasterization --enable-zero-copy --example-option";
        let enabled = arguments(inherited, true);
        assert!(enabled.starts_with(inherited));
        assert!(!enabled.split_whitespace().any(|arg| arg == "--disable-gpu"));
        let disabled = arguments(inherited, false);
        assert!(disabled.starts_with(inherited));
        assert!(disabled.split_whitespace().any(|arg| arg == "--disable-gpu"));
        assert!(disabled.contains("--disable-accelerated-video-decode"));
        assert!(disabled.contains("--disable-background-timer-throttling"));
        assert!(!disabled.contains("--disable-web-security"));
    }
}
