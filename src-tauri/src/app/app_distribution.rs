//! Detects how the application was distributed. MSIX packages from the Microsoft Store
//! receive updates through the Store, so the built-in updater stays inactive there.
use std::sync::OnceLock;

/// True when the running process has MSIX package identity (Microsoft Store install).
pub fn is_store_package() -> bool {
    static PACKAGED: OnceLock<bool> = OnceLock::new();
    *PACKAGED.get_or_init(detect_package_identity)
}

#[cfg(windows)]
fn detect_package_identity() -> bool {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::APPMODEL_ERROR_NO_PACKAGE;
    use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    let mut length = 0u32;
    // A zero-length query reports ERROR_INSUFFICIENT_BUFFER for packaged processes.
    let result = unsafe { GetCurrentPackageFullName(&mut length, PWSTR::null()) };
    result != APPMODEL_ERROR_NO_PACKAGE
}

#[cfg(not(windows))]
fn detect_package_identity() -> bool {
    false
}

/// Lets the interface hide self-update controls when the Store owns updates.
#[tauri::command]
pub fn store_managed_updates() -> bool {
    is_store_package()
}
