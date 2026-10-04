#[tauri::command]
pub fn get_system_locale() -> Result<String, String> {
    #[cfg(windows)]
    {
        use windows::Win32::Globalization::GetUserDefaultLocaleName;
        use windows::Win32::System::SystemServices::LOCALE_NAME_MAX_LENGTH;
        let mut buffer = [0u16; LOCALE_NAME_MAX_LENGTH as usize];
        let length = unsafe { GetUserDefaultLocaleName(&mut buffer) };
        if length == 0 { return Err("Could not read Windows language".into()); }
        return String::from_utf16(&buffer[..length as usize - 1]).map_err(|error| error.to_string());
    }
    #[cfg(not(windows))]
    Ok("en".into())
}

pub struct NoteDialogCopy {
    pub open_title: &'static str,
    pub save_title: &'static str,
    pub open_filter: &'static str,
    pub save_filter: &'static str,
    pub file_name: &'static str,
}

pub fn note_dialog_copy(language: Option<&str>) -> NoteDialogCopy {
    if language == Some("pt-BR") {
        NoteDialogCopy { open_title: "Abrir nota", save_title: "Salvar nota", open_filter: "Notas",
            save_filter: "Notas com formatação", file_name: "nota.html" }
    } else {
        NoteDialogCopy { open_title: "Open note", save_title: "Save note", open_filter: "Notes",
            save_filter: "Rich text notes", file_name: "note.html" }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_locale_is_valid_text() {
        let locale = get_system_locale().expect("Windows must expose its user locale");
        assert!(!locale.is_empty());
        assert!(!locale.contains('\0'));
    }
    #[test]
    fn native_note_dialog_copy_uses_the_app_language() {
        assert_eq!(note_dialog_copy(Some("pt-BR")).file_name, "nota.html");
        assert_eq!(note_dialog_copy(Some("en")).open_title, "Open note");
        assert_eq!(note_dialog_copy(None).file_name, "note.html");
    }
}
