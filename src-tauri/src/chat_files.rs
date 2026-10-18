use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::{self, File, OpenOptions}, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, sync::Mutex};
use tauri::State;

const CHUNK: usize = 256 * 1024;
const MAX_FILE: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Default)]
pub struct ChatFileState {
    sources: Mutex<HashMap<String, PathBuf>>,
    downloads: Mutex<HashMap<String, Download>>,
    completed: Mutex<HashMap<String, PathBuf>>,
    clipboard_sources: Mutex<HashMap<String, PathBuf>>,
}

struct Download { temp: PathBuf, destination: PathBuf, file: File, size: u64, written: u64, hash: String }

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
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() { return Err("Only regular files can be shared".into()); }
    let size = metadata.len();
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
pub async fn read_chat_file_chunk(state: State<'_, ChatFileState>, id: String, offset: u64,
    length: Option<usize>) -> Result<String, String> {
    read_source_chunk(&state, &id, offset, length).await.map(|bytes| STANDARD.encode(bytes))
}

#[tauri::command]
pub async fn read_chat_file_bytes(state: State<'_, ChatFileState>, id: String, offset: u64,
    length: Option<usize>) -> Result<tauri::ipc::Response, String> {
    read_source_chunk(&state, &id, offset, length).await.map(tauri::ipc::Response::new)
}

async fn read_source_chunk(state: &ChatFileState, id: &str, offset: u64,
    length: Option<usize>) -> Result<Vec<u8>, String> {
    let length = length.unwrap_or(CHUNK);
    if length == 0 || length > CHUNK { return Err("Invalid chunk size".into()); }
    let path = state.sources.lock().map_err(|e| e.to_string())?.get(id).cloned().ok_or("Source unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        if size > MAX_FILE || offset > size { return Err("Invalid source offset".into()); }
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut buffer = vec![0u8; length.min((size - offset) as usize)];
        file.read_exact(&mut buffer).map_err(|e| e.to_string())?;
        Ok(buffer)
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
    let file = OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| e.to_string())?;
    state.downloads.lock().map_err(|e| e.to_string())?.insert(id, Download { temp, destination, file, size, written: 0, hash });
    Ok(true)
}

#[tauri::command]
pub async fn write_chat_download_chunk(state: State<'_, ChatFileState>, id: String, offset: u64, data: String) -> Result<u64, String> {
    let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
    write_download_bytes(&state, &id, offset, &bytes)
}

fn download_headers(headers: &tauri::http::HeaderMap) -> Result<(&str, u64), String> {
    let id = headers.get("x-chat-download-id").and_then(|value| value.to_str().ok()).ok_or("Missing download ID")?;
    if id.is_empty() || id.len() > 80 { return Err("Invalid download ID".into()); }
    let offset = headers.get("x-chat-offset").and_then(|value| value.to_str().ok()).ok_or("Missing download offset")?;
    if offset.is_empty() || !offset.bytes().all(|byte| byte.is_ascii_digit()) { return Err("Invalid download offset".into()); }
    Ok((id, offset.parse().map_err(|_| "Invalid download offset")?))
}

#[tauri::command]
pub async fn write_chat_download_bytes(state: State<'_, ChatFileState>, request: tauri::ipc::Request<'_>) -> Result<u64, String> {
    let (id, offset) = download_headers(request.headers())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Expected binary file bytes".into()); };
    write_download_bytes(&state, id, offset, bytes)
}

fn write_download_bytes(state: &ChatFileState, id: &str, offset: u64, bytes: &[u8]) -> Result<u64, String> {
    if bytes.is_empty() || bytes.len() > CHUNK { return Err("Invalid chunk size".into()); }
    let mut downloads = state.downloads.lock().map_err(|e| e.to_string())?;
    let download = downloads.get_mut(id).ok_or("Download unavailable")?;
    if offset != download.written || offset + bytes.len() as u64 > download.size { return Err("Invalid chunk offset".into()); }
    download.file.write_all(bytes).map_err(|e| e.to_string())?;
    download.written += bytes.len() as u64;
    Ok(download.written)
}

#[tauri::command]
pub async fn finish_chat_download(state: State<'_, ChatFileState>, id: String) -> Result<String, String> {
    let download = state.downloads.lock().map_err(|e| e.to_string())?.remove(&id).ok_or("Download unavailable")?;
    drop(download.file);
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
        if let Some(download) = downloads.remove(&id) { drop(download.file); let _ = fs::remove_file(download.temp); }
    }
}

#[tauri::command]
pub fn read_chat_image_preview(state: State<'_, ChatFileState>, id: String) -> Result<String, String> {
    let path = state.completed.lock().map_err(|e| e.to_string())?.get(&id).cloned()
        .or_else(|| state.sources.lock().ok()?.get(&id).cloned()).ok_or("Image unavailable")?;
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 * 1024 || image::guess_format(&bytes).is_err() { return Err("Invalid image preview".into()); }
    Ok(STANDARD.encode(bytes))
}

fn register_source(state: &ChatFileState, path: PathBuf) -> Result<FileInfo, String> {
    let id = random_id()?;
    let info = file_info(id.clone(), &path)?;
    state.sources.lock().map_err(|e| e.to_string())?.insert(id, path);
    Ok(info)
}

#[tauri::command]
pub async fn import_chat_files(state: State<'_, ChatFileState>, paths: Vec<String>) -> Result<Vec<FileInfo>, String> {
    if paths.is_empty() || paths.len() > 32 { return Err("Select between 1 and 32 files".into()); }
    let sources = tauri::async_runtime::spawn_blocking(move || {
        paths.into_iter().map(|path| {
            let path = PathBuf::from(path);
            let info = file_info(random_id()?, &path)?;
            Ok((info, path))
        }).collect::<Result<Vec<_>, String>>()
    }).await.map_err(|e| e.to_string())??;
    let mut registered = state.sources.lock().map_err(|e| e.to_string())?;
    Ok(sources.into_iter().map(|(info, path)| { registered.insert(info.id.clone(), path); info }).collect())
}

const MAX_CLIPBOARD_GIF: usize = 16 * 1024 * 1024;

fn clipboard_gif_bytes(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_CLIPBOARD_GIF || !(bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        return Err("Invalid clipboard GIF".into());
    }
    let dimensions = image::ImageReader::with_format(std::io::Cursor::new(&bytes), image::ImageFormat::Gif)
        .into_dimensions().map_err(|_| "Invalid clipboard GIF")?;
    if dimensions.0 == 0 || dimensions.1 == 0 || dimensions.0 > 8192 || dimensions.1 > 8192 {
        return Err("Clipboard image too large".into());
    }
    Ok(bytes)
}

#[cfg(windows)]
fn native_clipboard_gif() -> Option<Vec<u8>> {
    use windows::{core::w, Win32::{Foundation::HGLOBAL, System::{DataExchange::{OpenClipboard, CloseClipboard, RegisterClipboardFormatW, GetClipboardData}, Memory::{GlobalLock, GlobalUnlock, GlobalSize}}}};
    unsafe {
        OpenClipboard(None).ok()?;
        struct ClipboardGuard;
        impl Drop for ClipboardGuard { fn drop(&mut self) { unsafe { let _ = CloseClipboard(); } } }
        let _guard = ClipboardGuard;
        for format in [w!("GIF"), w!("image/gif")] {
            let format = RegisterClipboardFormatW(format);
            if format == 0 { continue; }
            let Ok(handle) = GetClipboardData(format) else { continue; };
            let handle = HGLOBAL(handle.0);
            let size = GlobalSize(handle);
            if size == 0 || size > MAX_CLIPBOARD_GIF { continue; }
            let pointer = GlobalLock(handle);
            if pointer.is_null() { continue; }
            let bytes = std::slice::from_raw_parts(pointer as *const u8, size).to_vec();
            let _ = GlobalUnlock(handle);
            if let Ok(bytes) = clipboard_gif_bytes(bytes) { return Some(bytes); }
        }
        None
    }
}

#[cfg(not(windows))]
fn native_clipboard_gif() -> Option<Vec<u8>> { None }

#[cfg(windows)]
fn copy_clipboard_gif(bytes: &[u8]) -> Result<(), String> {
    use windows::{core::w, Win32::{Foundation::{GlobalFree, HANDLE}, System::{DataExchange::{OpenClipboard, CloseClipboard, RegisterClipboardFormatW, SetClipboardData}, Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE}}}};
    unsafe {
        OpenClipboard(None).map_err(|e| e.to_string())?;
        struct ClipboardGuard;
        impl Drop for ClipboardGuard { fn drop(&mut self) { unsafe { let _ = CloseClipboard(); } } }
        let _guard = ClipboardGuard;
        let format = RegisterClipboardFormatW(w!("GIF"));
        if format == 0 { return Err("Could not register clipboard GIF".into()); }
        let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|e| e.to_string())?;
        let pointer = GlobalLock(handle);
        if pointer.is_null() { let _ = GlobalFree(handle); return Err("Could not allocate clipboard GIF".into()); }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer as *mut u8, bytes.len());
        let _ = GlobalUnlock(handle);
        if let Err(error) = SetClipboardData(format, HANDLE(handle.0)) {
            let _ = GlobalFree(handle); return Err(error.to_string());
        }
        // Windows owns the allocation after SetClipboardData succeeds.
        Ok(())
    }
}

async fn pasted_gif_source(source: &str) -> Result<Vec<u8>, String> {
    if let Some(encoded) = source.strip_prefix("data:image/gif;base64,") {
        if encoded.len() > MAX_CLIPBOARD_GIF * 4 / 3 + 4 { return Err("Clipboard image too large".into()); }
        return clipboard_gif_bytes(STANDARD.decode(encoded).map_err(|_| "Invalid clipboard GIF")?);
    }
    let url = reqwest::Url::parse(source).map_err(|_| "Invalid clipboard GIF URL")?;
    if !matches!(url.scheme(), "https" | "http") || !url.username().is_empty() || url.password().is_some() {
        return Err("Invalid clipboard GIF URL".into());
    }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(3)).build().map_err(|e| e.to_string())?;
    let mut response = client.get(url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
    if response.content_length().is_some_and(|length| length > MAX_CLIPBOARD_GIF as u64) { return Err("Clipboard image too large".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > MAX_CLIPBOARD_GIF { return Err("Clipboard image too large".into()); }
        bytes.extend_from_slice(&chunk);
    }
    clipboard_gif_bytes(bytes)
}

#[tauri::command]
pub async fn paste_chat_files(state: State<'_, ChatFileState>, gif_source: Option<String>) -> Result<Vec<FileInfo>, String> {
    let gif = match gif_source { Some(source) => Some(pasted_gif_source(&source).await?), None => None };
    let sources = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<(PathBuf, bool)>, String> {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        match clipboard.get().file_list() {
            Ok(paths) if !paths.is_empty() => {
                if paths.len() > 32 { return Err("Select at most 32 files".into()); }
                return Ok(paths.into_iter().map(|path| (path, false)).collect());
            }
            Err(arboard::Error::ContentNotAvailable) | Ok(_) => {}
            Err(error) => return Err(error.to_string()),
        }
        if let Some(bytes) = gif.or_else(native_clipboard_gif) {
            let directory = dirs::data_local_dir().ok_or("Local data folder unavailable")?.join("P2Sharer").join("chat-clipboard");
            fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let path = directory.join(format!("clipboard-{}.gif", random_id()?));
            if let Err(error) = fs::write(&path, bytes) { let _ = fs::remove_file(&path); return Err(error.to_string()); }
            return Ok(vec![(path, true)]);
        }
        let pixels = match clipboard.get_image() {
            Ok(pixels) => pixels,
            Err(arboard::Error::ContentNotAvailable) => return Ok(Vec::new()),
            Err(error) => return Err(error.to_string()),
        };
        let width = u32::try_from(pixels.width).map_err(|_| "Image too wide")?;
        let height = u32::try_from(pixels.height).map_err(|_| "Image too tall")?;
        if pixels.bytes.len() > 256 * 1024 * 1024 { return Err("Clipboard image too large".into()); }
        let image = image::RgbaImage::from_raw(width, height, pixels.bytes.into_owned()).ok_or("Invalid clipboard image")?;
        let directory = dirs::data_local_dir().ok_or("Local data folder unavailable")?
            .join("P2Sharer").join("chat-clipboard");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let path = directory.join(format!("clipboard-{}.png", random_id()?));
        if let Err(error) = image.save_with_format(&path, image::ImageFormat::Png) {
            let _ = fs::remove_file(&path);
            return Err(error.to_string());
        }
        Ok(vec![(path, true)])
    }).await.map_err(|e| e.to_string())??;
    let mut files = Vec::new();
    for (path, managed) in sources {
        match register_source(&state, path.clone()) {
            Ok(info) => {
                if managed { state.clipboard_sources.lock().map_err(|e| e.to_string())?.insert(info.id.clone(), path); }
                files.push(info);
            }
            Err(error) => {
                if managed { let _ = fs::remove_file(path); }
                for info in files { discard_source(&state, &info.id); }
                return Err(error);
            }
        }
    }
    Ok(files)
}

fn discard_source(state: &ChatFileState, id: &str) {
    if let Ok(mut sources) = state.sources.lock() { sources.remove(id); }
    if let Ok(mut sources) = state.clipboard_sources.lock() {
        if let Some(path) = sources.remove(id) { let _ = fs::remove_file(path); }
    }
}

#[tauri::command]
pub fn discard_chat_file(state: State<'_, ChatFileState>, id: String) {
    discard_source(&state, &id);
}

#[tauri::command]
pub fn reveal_chat_download(state: State<'_, ChatFileState>, id: String) -> Result<(), String> {
    let path = state.completed.lock().map_err(|e| e.to_string())?.get(&id).cloned()
        .ok_or("Download unavailable")?;
    if !path.is_file() { return Err("Downloaded file is no longer available".into()); }
    std::process::Command::new("explorer.exe").arg("/select,").arg(path)
        .spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn decode_image_bytes(data_base64: &str) -> Result<(usize, usize, Vec<u8>), String> {
    let base64_str = if let Some(idx) = data_base64.find(";base64,") {
        &data_base64[idx + 8..]
    } else {
        data_base64
    };
    let bytes = STANDARD.decode(base64_str.trim()).map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("Image too large".into());
    }
    let dynamic_image = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let rgba = dynamic_image.to_rgba8();
    let width = usize::try_from(rgba.width()).map_err(|_| "Image too wide")?;
    let height = usize::try_from(rgba.height()).map_err(|_| "Image too tall")?;
    Ok((width, height, rgba.into_raw()))
}

#[tauri::command]
pub async fn copy_chat_image(data_base64: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (width, height, raw) = decode_image_bytes(&data_base64)?;
        let image_data = arboard::ImageData {
            width,
            height,
            bytes: std::borrow::Cow::Borrowed(&raw),
        };
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        clipboard.set_image(image_data).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        if let Some(encoded) = data_base64.strip_prefix("data:image/gif;base64,") {
            let bytes = clipboard_gif_bytes(STANDARD.decode(encoded).map_err(|e| e.to_string())?)?;
            copy_clipboard_gif(&bytes)?;
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}


#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn binary_source_reads_are_bounded_and_preserve_exact_bytes() {
        let state = ChatFileState::default();
        let path = std::env::temp_dir().join(format!("p2sharer-binary-{}", random_id().unwrap()));
        let bytes: Vec<u8> = (0..CHUNK + 7).map(|index| (index % 251) as u8).collect();
        fs::write(&path, &bytes).unwrap();
        let info = register_source(&state, path.clone()).unwrap();
        assert_eq!(read_source_chunk(&state, &info.id, 0, Some(CHUNK)).await.unwrap(), bytes[..CHUNK]);
        assert_eq!(read_source_chunk(&state, &info.id, CHUNK as u64, Some(CHUNK)).await.unwrap(), bytes[CHUNK..]);
        assert!(read_source_chunk(&state, &info.id, 0, Some(CHUNK + 1)).await.is_err());
        assert!(read_source_chunk(&state, &info.id, 0, Some(0)).await.is_err());
        assert!(read_source_chunk(&state, &info.id, bytes.len() as u64 + 1, Some(1)).await.is_err());
        assert!(read_source_chunk(&state, "unknown", 0, Some(1)).await.is_err());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn binary_download_headers_require_a_bounded_id_and_unsigned_offset() {
        let mut headers = tauri::http::HeaderMap::new();
        assert!(download_headers(&headers).is_err());
        headers.insert("x-chat-download-id", "request".parse().unwrap());
        for offset in ["", "-1", "+1", "1.5", "18446744073709551616"] {
            headers.insert("x-chat-offset", offset.parse().unwrap());
            assert!(download_headers(&headers).is_err());
        }
        headers.insert("x-chat-offset", "0".parse().unwrap());
        assert_eq!(download_headers(&headers).unwrap(), ("request", 0));
        headers.insert("x-chat-download-id", "a".repeat(81).parse().unwrap());
        assert!(download_headers(&headers).is_err());
    }

    #[test]
    fn binary_download_writes_share_one_handle_and_reject_invalid_ranges() {
        let state = ChatFileState::default();
        let path = std::env::temp_dir().join(format!("p2sharer-write-{}", random_id().unwrap()));
        let file = OpenOptions::new().write(true).create_new(true).open(&path).unwrap();
        state.downloads.lock().unwrap().insert("request".into(), Download {
            temp: path.clone(), destination: path.with_extension("complete"), file,
            size: (CHUNK + 3) as u64, written: 0, hash: String::new(),
        });
        assert!(write_download_bytes(&state, "unknown", 0, &[1]).is_err());
        assert!(write_download_bytes(&state, "request", 0, &[]).is_err());
        assert!(write_download_bytes(&state, "request", 0, &vec![0; CHUNK + 1]).is_err());
        assert!(write_download_bytes(&state, "request", 1, &[1]).is_err());
        assert_eq!(write_download_bytes(&state, "request", 0, &vec![0x42; CHUNK]).unwrap(), CHUNK as u64);
        assert!(write_download_bytes(&state, "request", CHUNK as u64, &[1, 2, 3, 4]).is_err());
        assert_eq!(write_download_bytes(&state, "request", CHUNK as u64, &[1, 2, 3]).unwrap(), (CHUNK + 3) as u64);
        drop(state.downloads.lock().unwrap().remove("request").unwrap());
        let bytes = fs::read(&path).unwrap();
        assert_eq!(&bytes[..CHUNK], &vec![0x42; CHUNK]);
        assert_eq!(&bytes[CHUNK..], &[1, 2, 3]);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn clipboard_gif_keeps_original_encoded_bytes_and_rejects_other_formats() {
        let bytes = STANDARD.decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==").unwrap();
        assert_eq!(clipboard_gif_bytes(bytes.clone()).unwrap(), bytes);
        assert!(clipboard_gif_bytes(b"not a GIF".to_vec()).is_err());
        assert!(clipboard_gif_bytes(vec![0; MAX_CLIPBOARD_GIF + 1]).is_err());
    }

    #[test]
    fn discarding_an_original_source_preserves_the_file() {
        let state = ChatFileState::default();
        let path = std::env::temp_dir().join(format!("p2sharer-original-{}", random_id().unwrap()));
        fs::write(&path, b"original").unwrap();
        let info = register_source(&state, path.clone()).unwrap();
        assert_eq!(info.size, 8);
        assert_eq!(state.sources.lock().unwrap().get(&info.id), Some(&path));
        discard_source(&state, &info.id);
        assert!(state.sources.lock().unwrap().is_empty());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn discarding_a_clipboard_source_removes_only_its_snapshot() {
        let state = ChatFileState::default();
        let path = std::env::temp_dir().join(format!("p2sharer-clipboard-{}.png", random_id().unwrap()));
        image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 255])).save(&path).unwrap();
        let info = register_source(&state, path.clone()).unwrap();
        assert!(info.is_image);
        state.clipboard_sources.lock().unwrap().insert(info.id.clone(), path.clone());
        discard_source(&state, &info.id);
        discard_source(&state, &info.id);
        assert!(!path.exists());
        assert!(state.sources.lock().unwrap().is_empty());
        assert!(state.clipboard_sources.lock().unwrap().is_empty());
    }

    #[test]
    fn rejects_directory_sources() {
        assert!(register_source(&ChatFileState::default(), std::env::temp_dir()).is_err());
    }

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

    #[test]
    fn decodes_image_for_clipboard() {
        let img = image::RgbaImage::from_pixel(3, 4, image::Rgba([10, 20, 30, 255]));
        let mut png_bytes = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png).unwrap();
        let encoded = format!("data:image/png;base64,{}", STANDARD.encode(&png_bytes));
        let (w, h, raw) = decode_image_bytes(&encoded).unwrap();
        assert_eq!(w, 3);
        assert_eq!(h, 4);
        assert_eq!(raw.len(), 3 * 4 * 4);
        assert_eq!(&raw[0..4], &[10, 20, 30, 255]);
    }
}
