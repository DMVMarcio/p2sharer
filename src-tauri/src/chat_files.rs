use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::{self, File, OpenOptions}, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, sync::Mutex};
use tauri::State;

const CHUNK: usize = 48 * 1024;
const MAX_FILE: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Default)]
pub struct ChatFileState {
    sources: Mutex<HashMap<String, PathBuf>>,
    downloads: Mutex<HashMap<String, Download>>,
    completed: Mutex<HashMap<String, PathBuf>>,
}

struct Download { temp: PathBuf, destination: PathBuf, size: u64, written: u64, hash: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo { id: String, name: String, path: String, size: u64, hash: String, is_image: bool }

fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn digest(path: &Path) -> Result<(u64, String), String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if size > MAX_FILE { return Err("File exceeds 2 GiB limit".into()); }
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hasher.update(&buffer[..n]);
    }
    Ok((size, format!("{:x}", hasher.finalize())))
}

fn safe_name(name: &str) -> Result<&str, String> {
    if name.is_empty() || name.len() > 180 || name == "." || name == ".." ||
        name.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c)) {
        return Err("Invalid file name".into());
    }
    Ok(name)
}

fn file_info(id: String, path: &Path) -> Result<FileInfo, String> {
    let (size, hash) = digest(path)?;
    let name = path.file_name().and_then(|n| n.to_str()).ok_or("Invalid file name")?.to_owned();
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    Ok(FileInfo { id, name, path: path.to_string_lossy().into_owned(), size, hash,
        is_image: matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp") })
}

fn source_index_path() -> Result<PathBuf, String> {
    let directory = dirs::data_local_dir().ok_or("Local data folder unavailable")?.join("P2Sharer");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory.join("chat-file-sources.json"))
}

fn read_source_index() -> Result<HashMap<String, PathBuf>, String> {
    let path = source_index_path()?;
    if !path.exists() { return Ok(HashMap::new()); }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 2_000_000 { return Err("Source index is too large".into()); }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remember_chat_file_source(state: State<'_, ChatFileState>, room_id: String, message_id: String,
    source_id: String) -> Result<(), String> {
    if room_id.len() > 160 || message_id.len() > 80 { return Err("Invalid source reference".into()); }
    let source = state.sources.lock().map_err(|e| e.to_string())?.get(&source_id).cloned().ok_or("Source unavailable")?;
    let mut index = read_source_index()?;
    index.insert(format!("{room_id}:{message_id}"), source);
    let target = source_index_path()?;
    let temp = target.with_extension("tmp");
    fs::write(&temp, serde_json::to_vec(&index).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(temp, target).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restore_chat_file_source(state: State<'_, ChatFileState>, room_id: String,
    message_id: String) -> Result<Option<FileInfo>, String> {
    if room_id.len() > 160 || message_id.len() > 80 { return Err("Invalid source reference".into()); }
    let Some(path) = read_source_index()?.get(&format!("{room_id}:{message_id}")).cloned() else { return Ok(None) };
    if !path.exists() { return Ok(None); }
    let id = random_id()?;
    let info = file_info(id.clone(), &path)?;
    state.sources.lock().map_err(|e| e.to_string())?.insert(id, path);
    Ok(Some(info))
}

#[tauri::command]
pub async fn pick_chat_file(state: State<'_, ChatFileState>) -> Result<Option<FileInfo>, String> {
    let path = tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().pick_file())
        .await.map_err(|e| e.to_string())?;
    let Some(path) = path else { return Ok(None) };
    let id = random_id()?;
    let info = tauri::async_runtime::spawn_blocking({ let id = id.clone(); let path = path.clone(); move || file_info(id, &path) })
        .await.map_err(|e| e.to_string())??;
    state.sources.lock().map_err(|e| e.to_string())?.insert(id, path);
    Ok(Some(info))
}

#[tauri::command]
pub async fn inspect_chat_file(state: State<'_, ChatFileState>, id: String) -> Result<FileInfo, String> {
    let path = state.sources.lock().map_err(|e| e.to_string())?.get(&id).cloned().ok_or("Source unavailable")?;
    tauri::async_runtime::spawn_blocking(move || file_info(id, &path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_chat_file_chunk(state: State<'_, ChatFileState>, id: String, offset: u64) -> Result<String, String> {
    let path = state.sources.lock().map_err(|e| e.to_string())?.get(&id).cloned().ok_or("Source unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        if size > MAX_FILE || offset > size { return Err("Invalid source offset".into()); }
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut buffer = vec![0u8; CHUNK.min((size - offset) as usize)];
        file.read_exact(&mut buffer).map_err(|e| e.to_string())?;
        Ok(STANDARD.encode(buffer))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn choose_chat_download(state: State<'_, ChatFileState>, id: String, name: String, size: u64,
    hash: String, save_as: bool) -> Result<bool, String> {
    safe_name(&name)?;
    if size > MAX_FILE || !hash.bytes().all(|b| b.is_ascii_hexdigit()) || hash.len() != 64 { return Err("Invalid file metadata".into()); }
    let destination = tauri::async_runtime::spawn_blocking(move || -> Result<Option<PathBuf>, String> {
        if save_as {
            return Ok(rfd::FileDialog::new().set_file_name(&name).save_file());
        }
        let dir = dirs::download_dir().ok_or("Downloads folder unavailable")?.join("P2Sharer Downloads");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let source = Path::new(&name);
        let stem = source.file_stem().and_then(|v| v.to_str()).unwrap_or("file");
        let ext = source.extension().and_then(|v| v.to_str()).unwrap_or("");
        for index in 0..10000 {
            let candidate = if index == 0 { dir.join(&name) } else if ext.is_empty() {
                dir.join(format!("{stem} ({index})"))
            } else { dir.join(format!("{stem} ({index}).{ext}")) };
            if !candidate.exists() { return Ok(Some(candidate)); }
        }
        Err("No available download name".into())
    }).await.map_err(|e| e.to_string())??;
    let Some(destination) = destination else { return Ok(false) };
    let temp = destination.with_extension(format!("p2sharer-{}.part", random_id()?));
    OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| e.to_string())?;
    state.downloads.lock().map_err(|e| e.to_string())?.insert(id, Download { temp, destination, size, written: 0, hash });
    Ok(true)
}

#[tauri::command]
pub async fn write_chat_download_chunk(state: State<'_, ChatFileState>, id: String, offset: u64, data: String) -> Result<u64, String> {
    let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len() > CHUNK { return Err("Invalid chunk size".into()); }
    let mut downloads = state.downloads.lock().map_err(|e| e.to_string())?;
    let download = downloads.get_mut(&id).ok_or("Download unavailable")?;
    if offset != download.written || offset + bytes.len() as u64 > download.size { return Err("Invalid chunk offset".into()); }
    OpenOptions::new().append(true).open(&download.temp).and_then(|mut file| file.write_all(&bytes)).map_err(|e| e.to_string())?;
    download.written += bytes.len() as u64;
    Ok(download.written)
}

#[tauri::command]
pub async fn finish_chat_download(state: State<'_, ChatFileState>, id: String) -> Result<String, String> {
    let download = state.downloads.lock().map_err(|e| e.to_string())?.remove(&id).ok_or("Download unavailable")?;
    if download.written != download.size { let _ = fs::remove_file(&download.temp); return Err("Incomplete download".into()); }
    let (size, hash) = digest(&download.temp)?;
    if size != download.size || hash != download.hash { let _ = fs::remove_file(&download.temp); return Err("File signature mismatch".into()); }
    if download.destination.exists() { let _ = fs::remove_file(&download.temp); return Err("Destination already exists".into()); }
    fs::rename(&download.temp, &download.destination).map_err(|e| e.to_string())?;
    state.completed.lock().map_err(|e| e.to_string())?.insert(id, download.destination.clone());
    Ok(download.destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn cancel_chat_download(state: State<'_, ChatFileState>, id: String) {
    if let Ok(mut downloads) = state.downloads.lock() {
        if let Some(download) = downloads.remove(&id) { let _ = fs::remove_file(download.temp); }
    }
}

#[tauri::command]
pub fn read_chat_image_preview(state: State<'_, ChatFileState>, id: String) -> Result<String, String> {
    let path = state.completed.lock().map_err(|e| e.to_string())?.get(&id).cloned()
        .or_else(|| state.sources.lock().ok()?.get(&id).cloned()).ok_or("Image unavailable")?;
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 10 * 1024 * 1024 || image::guess_format(&bytes).is_err() { return Err("Invalid image preview".into()); }
    Ok(STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_download_names() {
        for name in ["../escape", "a/b", "a\\b", "NUL:txt", "", ".", ".."] {
            assert!(safe_name(name).is_err());
        }
        assert!(safe_name("photo (1).png").is_ok());
    }

    #[test]
    fn computes_expected_sha256() {
        let path = std::env::temp_dir().join(format!("p2sharer-digest-{}", random_id().unwrap()));
        fs::write(&path, b"abc").unwrap();
        let result = digest(&path).unwrap();
        fs::remove_file(path).unwrap();
        assert_eq!(result.0, 3);
        assert_eq!(result.1, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
