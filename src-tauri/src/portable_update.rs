//! Signed portable payloads use the official updater download verifier, then a
//! detached copy of this executable replaces the original after its process exits.
use std::{fs, io::{Read, Seek, SeekFrom}, path::{Path, PathBuf}, sync::Mutex, time::Duration};
use tauri::{ipc::Channel, Manager, Resource, ResourceId, Webview};
use tauri_plugin_updater::Update;

const MARKER: &[u8] = b"\nP2SHARER_PORTABLE_V1\n";
const PREFIX: &str = ".p2sharer-update-";

fn has_marker(path: &Path) -> std::io::Result<bool> {
    let mut file = fs::File::open(path)?;
    if file.metadata()?.len() < MARKER.len() as u64 { return Ok(false); }
    file.seek(SeekFrom::End(-(MARKER.len() as i64)))?;
    let mut tail = vec![0; MARKER.len()];
    file.read_exact(&mut tail)?;
    Ok(tail == MARKER)
}

pub fn is_portable() -> Result<bool, String> {
    has_marker(&std::env::current_exe().map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn require_main(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" { return Err("Only the main window can update the application".into()); }
    Ok(())
}

struct PortableDownload(Mutex<Option<Vec<u8>>>);
impl Resource for PortableDownload {}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    Started { #[serde(rename = "contentLength")] content_length: Option<u64> },
    Progress { #[serde(rename = "chunkLength")] chunk_length: usize },
    Finished,
}

#[tauri::command]
pub async fn download_portable_update(webview: Webview, rid: ResourceId, on_event: Channel<DownloadEvent>) -> Result<ResourceId, String> {
    require_main(&webview)?;
    if !is_portable()? { return Err("Portable runtime required".into()); }
    let update = webview.resources_table().get::<Update>(rid).map_err(|e| e.to_string())?;
    if update.target != "windows-x86_64-portable" { return Err("Portable update target required".into()); }
    let mut started = false;
    // Update::download verifies the complete bytes with the configured public key.
    let bytes = update.download(|chunk_length, content_length| {
        if !started {
            let _ = on_event.send(DownloadEvent::Started { content_length });
            started = true;
        }
        let _ = on_event.send(DownloadEvent::Progress { chunk_length });
    }, || {}).await.map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"MZ") || !bytes.ends_with(MARKER) { return Err("Invalid portable executable".into()); }
    let _ = on_event.send(DownloadEvent::Finished);
    Ok(webview.resources_table().add(PortableDownload(Mutex::new(Some(bytes)))))
}

fn stage_update(target: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let mut random = [0u8; 16];
    getrandom::getrandom(&mut random).map_err(|e| e.to_string())?;
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let directory = target.parent().ok_or("Executable directory missing")?.join(format!("{PREFIX}{token}"));
    fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(directory.join("payload.exe"))?;
        use std::io::Write;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::copy(target, directory.join("helper.exe"))?;
        Ok(())
    })();
    if let Err(error) = result { clean_stage(&directory); return Err(error.to_string()); }
    Ok(directory)
}

fn clean_stage(directory: &Path) {
    for name in ["payload.exe", "helper.exe", "ready", "commit", "backup.exe", "error.txt"] {
        let _ = fs::remove_file(directory.join(name));
    }
    let _ = fs::remove_dir(directory);
}

#[tauri::command]
pub async fn install_portable_update(webview: Webview, bytes_rid: ResourceId) -> Result<(), String> {
    require_main(&webview)?;
    if !is_portable()? { return Err("Portable runtime required".into()); }
    let download = webview.resources_table().get::<PortableDownload>(bytes_rid).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut bytes = download.0.lock().map_err(|e| e.to_string())?;
        let payload = bytes.as_ref().ok_or("Update already installed")?;
        let target = std::env::current_exe().map_err(|e| e.to_string())?;
        let directory = stage_update(&target, payload)?;
        let mut command = std::process::Command::new(directory.join("helper.exe"));
        command.arg("--portable-replace").arg(&target).arg(std::process::id().to_string());
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        // prepare_app_update has enabled silent job breakaway after media teardown.
        let mut child = command.spawn().map_err(|e| { clean_stage(&directory); e.to_string() })?;
        for _ in 0..100 {
            if directory.join("ready").exists() {
                fs::write(directory.join("commit"), b"commit").map_err(|e| e.to_string())?;
                *bytes = None;
                return Ok(());
            }
            if child.try_wait().map_err(|e| e.to_string())?.is_some() { break; }
            std::thread::sleep(Duration::from_millis(50));
        }
        // Without the commit acknowledgement the helper leaves the original untouched.
        Err("Portable update helper did not become ready".into())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn restart_after_update(webview: Webview) -> Result<(), String> {
    require_main(&webview)?;
    if is_portable()? { webview.app_handle().exit(0); }
    else { webview.app_handle().restart(); }
    Ok(())
}

fn replace_payload(target: &Path, directory: &Path) -> std::io::Result<()> {
    let backup = directory.join("backup.exe");
    fs::rename(target, &backup)?;
    if let Err(error) = fs::rename(directory.join("payload.exe"), target) {
        // Keep a recoverable backup if even restoration is blocked externally.
        fs::rename(&backup, target)?;
        return Err(error);
    }
    Ok(())
}

#[cfg(windows)]
fn run_replacement(target: &Path, pid: u32) -> Result<(), String> {
    use windows::Win32::{Foundation::CloseHandle, System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE}};
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let directory = executable.parent().ok_or("Helper directory missing")?;
    let parent = target.parent().ok_or("Target directory missing")?;
    if directory.parent() != Some(parent) || !directory.file_name().unwrap_or_default().to_string_lossy().starts_with(PREFIX)
        || !has_marker(target).map_err(|e| e.to_string())?
        || !has_marker(&directory.join("payload.exe")).map_err(|e| e.to_string())? {
        return Err("Invalid portable replacement paths".into());
    }
    let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }.map_err(|e| e.to_string())?;
    if let Err(error) = fs::write(directory.join("ready"), b"ready") {
        unsafe { let _ = CloseHandle(process); }
        return Err(error.to_string());
    }
    let wait = unsafe { WaitForSingleObject(process, 120_000) };
    unsafe { let _ = CloseHandle(process); }
    if wait.0 != 0 { return Err("Timed out waiting for the portable application to exit".into()); }
    if !directory.join("commit").exists() { return Err("Portable update was not committed".into()); }
    let mut result = Err(std::io::Error::other("Portable replacement failed"));
    for _ in 0..100 {
        result = replace_payload(target, directory);
        if result.is_ok() { break; }
        if directory.join("backup.exe").exists() { break; }
        // Antivirus scanners and other instances may briefly retain a file lock.
        std::thread::sleep(Duration::from_millis(100));
    }
    if let Err(error) = &result {
        if !target.exists() && directory.join("backup.exe").exists() {
            let _ = fs::rename(directory.join("backup.exe"), target);
        }
        let _ = fs::write(directory.join("error.txt"), error.to_string());
    }
    let mut restart = std::process::Command::new(target);
    restart.current_dir(parent);
    if result.is_ok() { restart.arg("--portable-cleanup").arg(directory); }
    restart.spawn().map_err(|e| e.to_string())?;
    result.map_err(|e| e.to_string())
}

/// Runs before Tauri, invitation forwarding, logging or the child containment job.
pub fn run_helper_if_requested() -> bool {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_some_and(|arg| arg == "--portable-cleanup") {
        if let (Some(directory), Ok(executable)) = (args.get(2).map(PathBuf::from), std::env::current_exe()) {
            if directory.parent() == executable.parent()
                && directory.file_name().unwrap_or_default().to_string_lossy().starts_with(PREFIX) {
                for _ in 0..40 {
                    clean_stage(&directory);
                    if !directory.exists() { break; }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
        return false;
    }
    if !args.get(1).is_some_and(|arg| arg == "--portable-replace") { return false; }
    #[cfg(windows)] {
        if let (Some(target), Some(pid)) = (args.get(2), args.get(3).and_then(|arg| arg.to_str()).and_then(|arg| arg.parse().ok())) {
            if let Err(error) = run_replacement(Path::new(target), pid) { eprintln!("{error}"); }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_marker_survives_renaming_and_replacement_keeps_the_original_path() {
        let directory = std::env::temp_dir().join(format!("p2sharer-portable-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let target = directory.join("renamed app.exe");
        fs::write(&target, b"installed executable").unwrap();
        assert!(!has_marker(&target).unwrap());
        let old = [b"MZ old".as_slice(), MARKER].concat();
        let new = [b"MZ new".as_slice(), MARKER].concat();
        fs::write(&target, &old).unwrap();
        assert!(has_marker(&target).unwrap());
        let staged = stage_update(&target, &new).unwrap();
        #[cfg(windows)] {
            use std::os::windows::fs::OpenOptionsExt;
            let locked = fs::OpenOptions::new().read(true).share_mode(0).open(&target).unwrap();
            assert!(replace_payload(&target, &staged).is_err());
            assert_eq!(fs::read(staged.join("payload.exe")).unwrap(), new);
            drop(locked);
            assert_eq!(fs::read(&target).unwrap(), old);
        }
        replace_payload(&target, &staged).unwrap();
        assert_eq!(fs::read(&target).unwrap(), new);
        assert_eq!(fs::read(staged.join("backup.exe")).unwrap(), old);
        clean_stage(&staged);
        let staged = stage_update(&target, &old).unwrap();
        fs::remove_file(staged.join("payload.exe")).unwrap();
        assert!(replace_payload(&target, &staged).is_err());
        assert_eq!(fs::read(&target).unwrap(), new, "Failed replacements restore the original");
        clean_stage(&staged);
        fs::remove_file(target).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
