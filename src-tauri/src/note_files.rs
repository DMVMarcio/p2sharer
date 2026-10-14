const MAX_NOTE_BYTES: usize = 2_000_000;
use serde::{Deserialize, Serialize};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, sync::Mutex};
use tauri::Manager;

static NOTE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedNote {
    id: String,
    name: String,
    content: String,
    updated_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteLibrary {
    directory: String,
    notes: Vec<SavedNote>,
}

fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, c)| {
        if [8, 13, 18, 23].contains(&i) { c == b'-' } else { c.is_ascii_hexdigit() }
    })
}

fn note_path(directory: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) { return Err("Invalid note identifier".into()); }
    Ok(directory.join(format!("{}.json", id.to_ascii_lowercase())))
}

fn note_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().document_dir().map_err(|e| e.to_string())?.join("P2Sharer").join("Notes");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory)
}

fn read_note(path: &Path) -> Result<SavedNote, String> {
    let bytes = read_bounded(path, MAX_NOTE_BYTES + 4096)?;
    let note: SavedNote = serde_json::from_str(&bytes).map_err(|e| e.to_string())?;
    if !valid_id(&note.id) || note.name.trim().is_empty() || note.name.chars().count() > 80 || note.content.len() > MAX_NOTE_BYTES {
        return Err("Invalid saved note".into());
    }
    Ok(note)
}

fn read_bounded(path: &Path, limit: usize) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > limit { return Err("Note file is too large".into()); }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

fn persist_note(directory: &Path, mut note: SavedNote, expected_updated_at: Option<u64>) -> Result<SavedNote, String> {
    let path = note_path(directory, &note.id)?;
    note.id = note.id.to_ascii_lowercase();
    note.name = note.name.trim().to_owned();
    if note.name.is_empty() || note.name.chars().count() > 80 || note.content.len() > MAX_NOTE_BYTES {
        return Err("Invalid note name or size".into());
    }
    let current = match read_note(&path) {
        Ok(note) => Some(note),
        Err(_) if !path.exists() => None,
        Err(error) => return Err(error),
    };
    if current.as_ref().map(|note| note.updated_at) != expected_updated_at {
        return Err("This note changed on disk. Reopen it before saving.".into());
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64;
    note.updated_at = now.max(expected_updated_at.unwrap_or(0).saturating_add(1));
    let bytes = serde_json::to_vec(&note).map_err(|e| e.to_string())?;
    // JSON escaping can expand the content. Bound serialized records consistently with reads.
    if bytes.len() > MAX_NOTE_BYTES + 4096 { return Err("Note file is too large".into()); }
    let temporary = path.with_extension("tmp");
    let result = (|| {
        let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temporary, &path).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result?;
    Ok(note)
}

#[tauri::command]
pub async fn list_saved_notes(app: tauri::AppHandle) -> Result<NoteLibrary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = NOTE_LOCK.lock().map_err(|e| e.to_string())?;
        let directory = note_directory(&app)?;
        let mut notes = Vec::new();
        for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") { continue; }
            // One damaged record must not hide the rest of the library.
            if let Ok(mut note) = read_note(&path) {
                if note_path(&directory, &note.id)? != path { continue; }
                note.content.clear();
                notes.push(note);
            }
        }
        notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.name.cmp(&b.name)));
        Ok(NoteLibrary { directory: directory.to_string_lossy().into_owned(), notes })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_saved_note(app: tauri::AppHandle, id: String) -> Result<SavedNote, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = NOTE_LOCK.lock().map_err(|e| e.to_string())?;
        let note = read_note(&note_path(&note_directory(&app)?, &id)?)?;
        if !note.id.eq_ignore_ascii_case(&id) { return Err("Invalid saved note".into()); }
        Ok(note)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_library_note(app: tauri::AppHandle, id: String, name: String, content: String, expected_updated_at: Option<u64>) -> Result<SavedNote, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = NOTE_LOCK.lock().map_err(|e| e.to_string())?;
        persist_note(&note_directory(&app)?, SavedNote { id, name, content, updated_at: 0 }, expected_updated_at)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_note_file(language: Option<String>) -> Result<Option<(String, String)>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let copy = crate::localization::note_dialog_copy(language.as_deref());
        let Some(path) = rfd::FileDialog::new()
            .set_title(copy.open_title)
            .add_filter(copy.open_filter, &["html", "md", "txt"])
            .pick_file() else { return Ok(None); };
        let format = path.extension().and_then(|value| value.to_str()).unwrap_or("txt").to_ascii_lowercase();
        read_bounded(&path, MAX_NOTE_BYTES).map(|content| Some((content, format)))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_note_file(content: String, format: String, language: Option<String>) -> Result<bool, String> {
    if content.len() > MAX_NOTE_BYTES { return Err("Note file is too large".into()); }
    if !["html", "md", "txt"].contains(&format.as_str()) { return Err("Invalid export format".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let copy = crate::localization::note_dialog_copy(language.as_deref());
        let Some(path) = rfd::FileDialog::new()
            .set_title(copy.save_title)
            .add_filter(match format.as_str() { "md" => "Markdown", "txt" => if language.as_deref() == Some("pt-BR") { "Texto puro" } else { "Plain text" }, _ => copy.save_filter }, &[&format])
            .set_file_name(format!("{}.{}", copy.file_name.trim_end_matches(".html"), format))
            .save_file() else { return Ok(false); };
        std::fs::write(path, content).map(|_| true).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("p2sharer-note-test-{}-{nonce}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn note() -> SavedNote {
        SavedNote { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(), name: "  Notes  ".into(),
            content: "<p>First &amp; second</p>".into(), updated_at: 0 }
    }

    #[test]
    fn note_library_reopens_and_updates_the_same_file_without_losing_a_conflicting_save() {
        let fixture = Fixture::new();
        let first = persist_note(&fixture.0, note(), None).unwrap();
        let path = note_path(&fixture.0, &first.id).unwrap();
        let restored = read_note(&path).unwrap();
        assert_eq!(restored.content, first.content);
        assert_eq!(restored.name, "Notes");
        let mut edited = restored.clone();
        edited.content = "<h1>Changed</h1>".into();
        let second = persist_note(&fixture.0, edited, Some(first.updated_at)).unwrap();
        assert!(second.updated_at > first.updated_at);
        assert!(persist_note(&fixture.0, restored.clone(), Some(first.updated_at)).is_err());
        assert!(persist_note(&fixture.0, restored, None).is_err());
        assert_eq!(read_note(&path).unwrap().content, second.content);
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn note_library_rejects_invalid_paths_sizes_and_names_without_changing_saved_data() {
        let fixture = Fixture::new();
        for id in ["../outside", "", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee/"] {
            assert!(note_path(&fixture.0, id).is_err());
        }
        let first = persist_note(&fixture.0, note(), None).unwrap();
        let mut invalid = first.clone();
        invalid.name = " ".into();
        assert!(persist_note(&fixture.0, invalid, Some(first.updated_at)).is_err());
        let mut oversized = first.clone();
        oversized.content = "x".repeat(MAX_NOTE_BYTES + 1);
        assert!(persist_note(&fixture.0, oversized, Some(first.updated_at)).is_err());
        assert_eq!(read_note(&note_path(&fixture.0, &first.id).unwrap()).unwrap().content, first.content);
        let plain = fixture.0.join("import.txt");
        fs::write(&plain, "**literal**\n<text> á").unwrap();
        assert_eq!(read_bounded(&plain, MAX_NOTE_BYTES).unwrap(), "**literal**\n<text> á");
        assert!(read_bounded(&plain, 4).is_err());
    }
}
