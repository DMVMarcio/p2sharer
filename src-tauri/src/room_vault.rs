use std::fs;
use std::path::PathBuf;
use tauri::Manager;

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

#[tauri::command]
pub fn save_room_record(app: tauri::AppHandle, room_id: String, data: String) -> Result<(), String> {
    if data.len() > 131_072 { return Err("Room record is too large".into()); }
    let path = room_path(&app, &room_id)?;
    #[cfg(windows)]
    {
        let ciphertext = protect(data.as_bytes())?;
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
    if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
    Ok(())
}
