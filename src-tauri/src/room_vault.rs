use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[cfg(windows)]
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
#[cfg(windows)]
use std::fs::{File, OpenOptions};
#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
use windows::Win32::Foundation::{LocalFree, HLOCAL};
#[cfg(windows)]
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
};
#[cfg(windows)]
use windows::core::PCWSTR;

fn room_path(app: &tauri::AppHandle, room_id: &str) -> Result<PathBuf, String> {
    if room_id.len() != 32 || !room_id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid room identifier".into());
    }
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("rooms");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{}.vault", room_id.to_ascii_lowercase())))
}

#[cfg(windows)]
fn protect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, PCWSTR::null(), None, None, None,
            CRYPTPROTECT_UI_FORBIDDEN, &mut output).map_err(|e| e.to_string())?;
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(HLOCAL(output.pbData as *mut _));
        Ok(result)
    }
}

#[cfg(windows)]
fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None,
            CRYPTPROTECT_UI_FORBIDDEN, &mut output).map_err(|e| e.to_string())?;
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(HLOCAL(output.pbData as *mut _));
        Ok(result)
    }
}

#[cfg(windows)]
fn invite_version(record: &serde_json::Value) -> Result<(String, u64, u64), String> {
    let invite = record.get("invite").and_then(|value| value.as_str())
        .ok_or("Missing room invitation")?;
    let (prefix, payload) = invite.split_once('.').ok_or("Invalid room invitation")?;
    if prefix != "p2s3" && prefix != "p2s4" { return Err("Invalid room invitation version".into()); }
    let decoded = URL_SAFE_NO_PAD.decode(payload).map_err(|e| e.to_string())?;
    let fields: serde_json::Value = serde_json::from_slice(&decoded).map_err(|e| e.to_string())?;
    let fields = fields.as_array().ok_or("Invalid room invitation payload")?;
    let root = fields.get(1).and_then(|value| value.as_str()).ok_or("Missing creator key")?.to_owned();
    if prefix == "p2s3" { return Ok((root, 0, 0)); }
    let epoch = fields.get(3).and_then(|value| value.as_u64()).ok_or("Invalid authority epoch")?;
    let revision = fields.get(4).and_then(|value| value.as_u64()).ok_or("Invalid invitation revision")?;
    Ok((root, epoch, revision))
}

#[cfg(windows)]
fn retain_newer_invite(incoming: &mut serde_json::Value, current: &serde_json::Value) -> Result<(), String> {
    let (incoming_key, incoming_epoch, incoming_revision) = invite_version(incoming)?;
    let (current_key, current_epoch, current_revision) = invite_version(current)?;
    if incoming_key != current_key { return Err("Room creator key changed".into()); }
    let incoming_rank = (incoming_epoch, incoming_revision);
    let current_rank = (current_epoch, current_revision);
    if incoming_rank == current_rank && incoming.get("invite") != current.get("invite") {
        return Err("Conflicting room invitation revision".into());
    }
    if incoming_rank < current_rank {
        incoming["invite"] = current["invite"].clone();
        incoming["name"] = current["name"].clone();
        if incoming.get("customName").is_none() && current.get("customName").is_some() {
            incoming["customName"] = current["customName"].clone();
        }
    }
    Ok(())
}

#[cfg(windows)]
fn lock_room_file(path: &Path) -> Result<File, String> {
    let lock_path = path.with_extension("lock");
    for _ in 0..100 {
        match OpenOptions::new().create(true).read(true).write(true).share_mode(0).open(&lock_path) {
            Ok(file) => return Ok(file),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Room vault is busy".into())
}

#[tauri::command]
pub fn save_room_record(app: tauri::AppHandle, room_id: String, data: String) -> Result<(), String> {
    if data.len() > 131_072 { return Err("Room record is too large".into()); }
    let path = room_path(&app, &room_id)?;
    #[cfg(windows)]
    {
        let _lock = lock_room_file(&path)?;
        let mut incoming: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        if path.exists() {
            let previous = fs::read(&path).map_err(|e| e.to_string())?;
            let plaintext = unprotect(&previous)?;
            let current: serde_json::Value = serde_json::from_slice(&plaintext).map_err(|e| e.to_string())?;
            retain_newer_invite(&mut incoming, &current)?;
        }
        let serialized = serde_json::to_vec(&incoming).map_err(|e| e.to_string())?;
        let ciphertext = protect(&serialized)?;
        fs::write(path, ciphertext).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    { let _ = path; Err("Protected room storage requires Windows".into()) }
}

#[tauri::command]
pub fn list_room_records(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("rooms");
    if !dir.exists() { return Ok(Vec::new()); }
    let mut records = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|e| e.to_str()) != Some("vault") { continue; }
        #[cfg(windows)]
        let _lock = lock_room_file(&entry.path())?;
        let ciphertext = fs::read(entry.path()).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        records.push(String::from_utf8(unprotect(&ciphertext)?).map_err(|e| e.to_string())?);
        #[cfg(not(windows))]
        { let _ = ciphertext; return Err("Protected room storage requires Windows".into()); }
    }
    Ok(records)
}

#[tauri::command]
pub fn delete_room_record(app: tauri::AppHandle, room_id: String) -> Result<(), String> {
    let path = room_path(&app, &room_id)?;
    #[cfg(windows)]
    let _lock = lock_room_file(&path)?;
    if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn record(revision: u64, name: &str) -> serde_json::Value {
        let payload = serde_json::json!(["room", "creator", name, 0, revision, [], [], "signature"]);
        serde_json::json!({
            "invite": format!("p2s4.{}", URL_SAFE_NO_PAD.encode(payload.to_string())),
            "name": name,
            "customName": "My local title",
        })
    }

    #[test]
    fn native_vault_keeps_newer_invitation_when_another_process_writes_old_state() {
        let current = record(12, "Current name");
        let mut stale = record(10, "Old name");
        stale.as_object_mut().unwrap().remove("customName");
        retain_newer_invite(&mut stale, &current).unwrap();
        assert_eq!(stale["invite"], current["invite"]);
        assert_eq!(stale["name"], "Current name");
        assert_eq!(stale["customName"], "My local title");
        let mut conflict = record(12, "Conflicting name");
        assert!(retain_newer_invite(&mut conflict, &current).is_err());
    }
}
