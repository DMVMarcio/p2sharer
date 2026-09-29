const MAX_NOTE_BYTES: usize = 2_000_000;

#[tauri::command]
pub async fn open_note_file() -> Result<Option<(String, String)>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(path) = rfd::FileDialog::new()
            .add_filter("Notes", &["html", "md", "txt"])
            .pick_file() else { return Ok(None); };
        let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if metadata.len() > MAX_NOTE_BYTES as u64 { return Err("Note file is too large".into()); }
        let format = path.extension().and_then(|value| value.to_str()).unwrap_or("txt").to_ascii_lowercase();
        std::fs::read_to_string(path).map(|content| Some((content, format))).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_note_file(content: String) -> Result<bool, String> {
    if content.len() > MAX_NOTE_BYTES { return Err("Note file is too large".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = rfd::FileDialog::new()
            .add_filter("Rich text notes", &["html"])
            .set_file_name("nota.html")
            .save_file() else { return Ok(false); };
        std::fs::write(path, content).map(|_| true).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}
