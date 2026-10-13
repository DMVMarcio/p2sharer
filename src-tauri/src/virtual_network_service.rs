//! Demand-start Windows service. Installation is the only elevated UI operation.
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicIsize, Ordering},
    time::{Duration, Instant},
};
use windows::{
    core::{w, PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, LocalFree, HLOCAL},
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            SetFileSecurityW, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        },
        System::{
            Com::CoTaskMemFree,
            Services::*,
            Threading::{GetExitCodeProcess, WaitForSingleObject},
        },
        UI::{
            Shell::{
                FOLDERID_ProgramFiles, SHGetKnownFolderPath, ShellExecuteExW, KF_FLAG_DEFAULT,
                SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
            },
            WindowsAndMessaging::SW_HIDE,
        },
    },
};

const NAME: PCWSTR = w!("P2SharerVirtualNetwork");
const SERVICE_DACL: &str = "O:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;LCRPCC;;;IU)";
const FILE_DACL: &str = "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;BU)";
static STOPPING: AtomicBool = AtomicBool::new(false);
static STATUS_HANDLE: AtomicIsize = AtomicIsize::new(0);

struct ServiceHandle(SC_HANDLE);
// SCM handles have no apartment/thread affinity. RAII owns the sole close;
// shared process handles are kept alive by Arc during concurrent status reads.
unsafe impl Send for ServiceHandle {}
unsafe impl Sync for ServiceHandle {}
impl Drop for ServiceHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseServiceHandle(self.0);
        }
    }
}
pub struct ServiceProcess(ServiceHandle);
impl ServiceProcess {
    pub fn exited(&self) -> bool {
        status(self.0 .0).is_ok_and(|s| s.dwCurrentState == SERVICE_STOPPED)
    }
    pub fn wait(&self) -> Result<(), String> {
        let end = Instant::now() + Duration::from_secs(15);
        while Instant::now() < end {
            if self.exited() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("Virtual network service is still shutting down".into())
    }
}
fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    s.encode_wide().chain(Some(0)).collect()
}
fn status(service: SC_HANDLE) -> Result<SERVICE_STATUS, String> {
    let mut status = SERVICE_STATUS::default();
    unsafe { QueryServiceStatus(service, &mut status) }.map_err(|e| e.to_string())?;
    Ok(status)
}
fn manager(access: u32) -> Result<ServiceHandle, String> {
    unsafe { OpenSCManagerW(None, None, access) }
        .map(ServiceHandle)
        .map_err(|e| e.to_string())
}
fn installed(manager: &ServiceHandle, access: u32) -> Result<Option<ServiceHandle>, String> {
    match unsafe { OpenServiceW(manager.0, NAME, access) } {
        Ok(handle) => Ok(Some(ServiceHandle(handle))),
        Err(e) if e.code().0 as u32 == 0x80070424 => Ok(None), // ERROR_SERVICE_DOES_NOT_EXIST
        Err(e) => Err(e.to_string()),
    }
}
fn destination(executable: &Path) -> Result<PathBuf, String> {
    // Resolve the system-owned folder through Windows, never caller environment variables.
    let base = unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramFiles, KF_FLAG_DEFAULT, None) }
        .map_err(|e| e.to_string())?;
    let folder = unsafe { base.to_string() }.map_err(|e| e.to_string());
    unsafe {
        CoTaskMemFree(Some(base.0 as _));
    }
    let hash = Sha256::digest(std::fs::read(executable).map_err(|e| e.to_string())?);
    let hash: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    Ok(PathBuf::from(folder?)
        .join("P2Sharer Network")
        .join(format!("network-{hash}.exe")))
}
fn command(path: &Path) -> String {
    format!("\"{}\" --p2sharer-vnet-service", path.display())
}
fn configuration(service: SC_HANDLE) -> Result<String, String> {
    let mut needed = 0;
    unsafe {
        let _ = QueryServiceConfigW(service, None, 0, &mut needed);
    }
    if needed == 0 || needed > 65_536 {
        return Err("Invalid virtual network service configuration".into());
    }
    // The Win32 structure must be aligned, unlike a Vec<u8> allocation's contract.
    let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
    let row = buffer.as_mut_ptr().cast::<QUERY_SERVICE_CONFIGW>();
    unsafe {
        QueryServiceConfigW(service, Some(row), needed, &mut needed).map_err(|e| e.to_string())?;
        if (*row).dwServiceType != SERVICE_WIN32_OWN_PROCESS
            || (*row).dwStartType != SERVICE_DEMAND_START
        {
            return Err("Unexpected virtual network service configuration".into());
        }
        (*row)
            .lpBinaryPathName
            .to_string()
            .map_err(|e| e.to_string())
    }
}
fn with_descriptor<T>(
    sddl: &str,
    operation: impl FnOnce(PSECURITY_DESCRIPTOR) -> Result<T, String>,
) -> Result<T, String> {
    let text: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(text.as_ptr()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
    }
    .map_err(|e| e.to_string())?;
    let result = operation(descriptor);
    unsafe {
        let _ = LocalFree(HLOCAL(descriptor.0));
    }
    result
}
fn protect_file(path: &Path) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_attributes() & 0x400 != 0 {
        return Err("Service paths cannot be reparse points".into());
    }
    let name = wide(path.as_os_str());
    with_descriptor(FILE_DACL, |descriptor| unsafe {
        SetFileSecurityW(
            PCWSTR(name.as_ptr()),
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        )
        .ok()
        .map_err(|e| e.to_string())
    })
}
fn install() -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    use std::os::windows::fs::OpenOptionsExt;
    // Keep the approved source immutable throughout hashing, copying and verification.
    let _source = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&executable)
        .map_err(|e| e.to_string())?;
    let path = destination(&executable)?;
    let manager = manager(SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE)?;
    let existing = installed(&manager, SERVICE_ALL_ACCESS)?;
    if existing
        .as_ref()
        .is_some_and(|s| status(s.0).is_ok_and(|s| s.dwCurrentState != SERVICE_STOPPED))
    {
        return Err("Close active tunnel apps before updating the network service".into());
    }
    let folder = path.parent().ok_or("Invalid service path")?;
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    protect_file(folder)?;
    if !path.exists() {
        std::fs::copy(&executable, &path).map_err(|e| e.to_string())?;
    }
    protect_file(&path)?;
    if std::fs::read(&path).map_err(|e| e.to_string())?
        != std::fs::read(&executable).map_err(|e| e.to_string())?
    {
        return Err("Network service executable verification failed".into());
    }
    let binary: Vec<u16> = command(&path).encode_utf16().chain(Some(0)).collect();
    let service = if let Some(service) = existing {
        unsafe {
            ChangeServiceConfigW(
                service.0,
                SERVICE_WIN32_OWN_PROCESS,
                SERVICE_DEMAND_START,
                SERVICE_ERROR_NORMAL,
                PCWSTR(binary.as_ptr()),
                None,
                None,
                None,
                w!("LocalSystem"),
                None,
                None,
            )
        }
        .map_err(|e| e.to_string())?;
        service
    } else {
        ServiceHandle(
            unsafe {
                CreateServiceW(
                    manager.0,
                    NAME,
                    w!("P2Sharer Virtual Network"),
                    SERVICE_ALL_ACCESS,
                    SERVICE_WIN32_OWN_PROCESS,
                    SERVICE_DEMAND_START,
                    SERVICE_ERROR_NORMAL,
                    PCWSTR(binary.as_ptr()),
                    None,
                    None,
                    None,
                    None,
                    None,
                )
            }
            .map_err(|e| e.to_string())?,
        )
    };
    // Interactive users can start and inspect only. Never grant binary/configuration changes.
    with_descriptor(SERVICE_DACL, |descriptor| unsafe {
        SetServiceObjectSecurity(
            service.0,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            descriptor,
        )
        .map_err(|e| e.to_string())
    })?;
    Ok(())
}
fn approve_installation() -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = wide(executable.as_os_str());
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(path.as_ptr()),
        lpParameters: w!("--p2sharer-vnet-install"),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe { ShellExecuteExW(&mut info) }
        .map_err(|_| "Network service installation requires administrator consent")?;
    let result = unsafe {
        let wait = WaitForSingleObject(info.hProcess, 90_000);
        let mut code = 1;
        let read = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
        if wait.0 == 0 && read.is_ok() && code == 0 {
            Ok(())
        } else {
            Err("Network service installation failed; check the native log".into())
        }
    };
    result
}
fn uninstall() -> Result<(), String> {
    let manager = manager(SC_MANAGER_CONNECT)?;
    if let Some(service) = installed(&manager, SERVICE_QUERY_STATUS | 0x0001_0000)? {
        if status(service.0)?.dwCurrentState != SERVICE_STOPPED {
            return Err("Close active tunnel apps before updating the network service".into());
        }
        unsafe { DeleteService(service.0) }.map_err(|e| e.to_string())?;
    }
    // Keep protected binaries for in-flight installer/uninstaller handles;
    // removal revokes the persistent authorization without deleting app data.
    Ok(())
}
pub fn start(port: u16, token: &str) -> Result<ServiceProcess, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let expected = command(&destination(&executable)?);
    let manager = manager(SC_MANAGER_CONNECT)?;
    let access = SERVICE_START | SERVICE_QUERY_STATUS | SERVICE_QUERY_CONFIG;
    let mut service = installed(&manager, access)?;
    if service
        .as_ref()
        .map(|s| configuration(s.0))
        .transpose()?
        .as_deref()
        != Some(&expected)
    {
        approve_installation()?;
        service = installed(&manager, access)?;
    }
    let service = service.ok_or("Network service was not installed")?;
    if configuration(service.0)? != expected {
        return Err("Network service version verification failed".into());
    }
    if status(service.0)?.dwCurrentState != SERVICE_STOPPED {
        return Err("Virtual network is in use by another P2Sharer process".into());
    }
    let port: Vec<u16> = port.to_string().encode_utf16().chain(Some(0)).collect();
    let token: Vec<u16> = token.encode_utf16().chain(Some(0)).collect();
    unsafe {
        StartServiceW(
            service.0,
            Some(&[PCWSTR(port.as_ptr()), PCWSTR(token.as_ptr())]),
        )
    }
    .map_err(|e| e.to_string())?;
    Ok(ServiceProcess(service))
}
pub fn stopping() -> bool {
    STOPPING.load(Ordering::Acquire)
}
fn report(state: SERVICE_STATUS_CURRENT_STATE, code: u32) {
    let handle = STATUS_HANDLE.load(Ordering::Acquire);
    if handle == 0 {
        return;
    }
    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: if state == SERVICE_RUNNING {
            SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
        } else {
            0
        },
        dwWin32ExitCode: code,
        dwWaitHint: if state == SERVICE_STOP_PENDING {
            15_000
        } else {
            0
        },
        ..Default::default()
    };
    unsafe {
        let _ = SetServiceStatus(SERVICE_STATUS_HANDLE(handle as _), &status);
    }
}
unsafe extern "system" fn control(
    code: u32,
    _: u32,
    _: *mut std::ffi::c_void,
    _: *mut std::ffi::c_void,
) -> u32 {
    if code == SERVICE_CONTROL_STOP || code == SERVICE_CONTROL_SHUTDOWN {
        STOPPING.store(true, Ordering::Release);
        report(SERVICE_STOP_PENDING, 0);
    }
    0
}
unsafe extern "system" fn service_main(count: u32, args: *mut PWSTR) {
    let Ok(handle) = RegisterServiceCtrlHandlerExW(NAME, Some(control), None) else {
        return;
    };
    STATUS_HANDLE.store(handle.0 as isize, Ordering::Release);
    report(SERVICE_START_PENDING, 0);
    crate::logger::init_logger();
    let result = std::panic::catch_unwind(|| -> Result<(), String> {
        if count != 3 || args.is_null() {
            return Err("Invalid service startup arguments".into());
        }
        let port = (*args.add(1))
            .to_string()
            .map_err(|e| e.to_string())?
            .parse::<u16>()
            .map_err(|_| "Invalid service port")?;
        let token = (*args.add(2)).to_string().map_err(|e| e.to_string())?;
        if port == 0 || token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid service authentication".into());
        }
        report(SERVICE_RUNNING, 0);
        crate::virtual_network::helper(port, &token)
    })
    .unwrap_or_else(|_| Err("Virtual network service panicked".into()));
    if let Err(error) = &result {
        crate::logger::log_msg("ERROR", "virtual_network_service", error);
    }
    report(SERVICE_STOPPED, if result.is_ok() { 0 } else { 1066 });
}
pub fn run_if_requested(args: &[String]) -> bool {
    match args.get(1).map(String::as_str) {
        Some("--p2sharer-vnet-install") if args.len() == 2 => {
            crate::logger::init_logger();
            if let Err(error) = install() {
                crate::logger::log_msg("ERROR", "virtual_network_service_install", &error);
                std::process::exit(1);
            }
            true
        }
        Some("--p2sharer-vnet-service") if args.len() == 2 => {
            let mut name: Vec<u16> = "P2SharerVirtualNetwork"
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let table = [
                SERVICE_TABLE_ENTRYW {
                    lpServiceName: PWSTR(name.as_mut_ptr()),
                    lpServiceProc: Some(service_main),
                },
                SERVICE_TABLE_ENTRYW::default(),
            ];
            unsafe {
                let _ = StartServiceCtrlDispatcherW(table.as_ptr());
            }
            true
        }
        Some("--p2sharer-vnet-uninstall") if args.len() == 2 => {
            crate::logger::init_logger();
            if let Err(error) = uninstall() {
                crate::logger::log_msg("ERROR", "virtual_network_service_uninstall", &error);
                std::process::exit(1);
            }
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::{
        Foundation::BOOL,
        Security::{
            GetAce, GetSecurityDescriptorDacl, GetSecurityDescriptorOwner, IsWellKnownSid,
            WinBuiltinAdministratorsSid, WinInteractiveSid, ACCESS_ALLOWED_ACE, PSID,
        },
    };

    #[test]
    fn interactive_users_can_start_but_cannot_reconfigure_the_service() {
        with_descriptor(SERVICE_DACL, |descriptor| unsafe {
            let mut owner = PSID::default();
            let mut owner_defaulted = BOOL(0);
            GetSecurityDescriptorOwner(descriptor, &mut owner, &mut owner_defaulted).unwrap();
            assert!(IsWellKnownSid(owner, WinBuiltinAdministratorsSid).as_bool());
            let mut present = BOOL(0);
            let mut defaulted = BOOL(0);
            let mut acl = std::ptr::null_mut();
            GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted).unwrap();
            assert!(present.as_bool() && !acl.is_null());
            let mut found = false;
            for index in 0..(*acl).AceCount as u32 {
                let mut pointer = std::ptr::null_mut();
                GetAce(acl, index, &mut pointer).unwrap();
                let ace = pointer.cast::<ACCESS_ALLOWED_ACE>();
                let sid = PSID(std::ptr::addr_of!((*ace).SidStart) as _);
                if IsWellKnownSid(sid, WinInteractiveSid).as_bool() {
                    found = true;
                    assert_eq!(
                        (*ace).Mask,
                        SERVICE_START | SERVICE_QUERY_STATUS | SERVICE_QUERY_CONFIG
                    );
                }
            }
            assert!(found);
            Ok(())
        })
        .unwrap();
    }
}
