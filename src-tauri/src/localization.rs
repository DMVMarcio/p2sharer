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


pub fn whiteboard_dialog_copy(language: Option<&str>) -> NoteDialogCopy {
    match language {
        Some("pt-BR") => NoteDialogCopy { open_title: "Importar quadro", save_title: "Exportar quadro", open_filter: "Quadro branco", save_filter: "Quadro branco", file_name: "whiteboard.p2board" },
        Some("es") => NoteDialogCopy { open_title: "Importar pizarra", save_title: "Exportar pizarra", open_filter: "Pizarra", save_filter: "Pizarra", file_name: "whiteboard.p2board" },
        Some("fr") => NoteDialogCopy { open_title: "Importer un tableau", save_title: "Exporter le tableau", open_filter: "Tableau blanc", save_filter: "Tableau blanc", file_name: "whiteboard.p2board" },
        Some("de") => NoteDialogCopy { open_title: "Whiteboard importieren", save_title: "Whiteboard exportieren", open_filter: "Whiteboard", save_filter: "Whiteboard", file_name: "whiteboard.p2board" },
        Some("it") => NoteDialogCopy { open_title: "Importa lavagna", save_title: "Esporta lavagna", open_filter: "Lavagna", save_filter: "Lavagna", file_name: "whiteboard.p2board" },
        Some("zh-CN") => NoteDialogCopy { open_title: "导入白板", save_title: "导出白板", open_filter: "白板", save_filter: "白板", file_name: "whiteboard.p2board" },
        Some("zh-TW") => NoteDialogCopy { open_title: "匯入白板", save_title: "匯出白板", open_filter: "白板", save_filter: "白板", file_name: "whiteboard.p2board" },
        Some("ja") => NoteDialogCopy { open_title: "ホワイトボードを読み込む", save_title: "ホワイトボードを出力", open_filter: "ホワイトボード", save_filter: "ホワイトボード", file_name: "whiteboard.p2board" },
        Some("ko") => NoteDialogCopy { open_title: "화이트보드 가져오기", save_title: "화이트보드 내보내기", open_filter: "화이트보드", save_filter: "화이트보드", file_name: "whiteboard.p2board" },
        Some("hi") => NoteDialogCopy { open_title: "व्हाइटबोर्ड आयात करें", save_title: "व्हाइटबोर्ड निर्यात करें", open_filter: "व्हाइटबोर्ड", save_filter: "व्हाइटबोर्ड", file_name: "whiteboard.p2board" },
        Some("fi") => NoteDialogCopy { open_title: "Tuo valkotaulu", save_title: "Vie valkotaulu", open_filter: "Valkotaulu", save_filter: "Valkotaulu", file_name: "whiteboard.p2board" },
        Some("ru") => NoteDialogCopy { open_title: "Импорт доски", save_title: "Экспорт доски", open_filter: "Доска", save_filter: "Доска", file_name: "whiteboard.p2board" },
        _ => NoteDialogCopy { open_title: "Import whiteboard", save_title: "Export whiteboard", open_filter: "Whiteboard", save_filter: "Whiteboard", file_name: "whiteboard.p2board" },
    }
}

pub struct BrowserDialogCopy {
    pub extension_title: &'static str,
    pub download_title: &'static str,
}

pub fn browser_dialog_copy(language: Option<&str>) -> BrowserDialogCopy {
    if language == Some("pt-BR") {
        BrowserDialogCopy { extension_title: "Selecionar extensão", download_title: "Salvar download do Navegador" }
    } else {
        BrowserDialogCopy { extension_title: "Select extension", download_title: "Save shared browser download" }
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
        assert_eq!(browser_dialog_copy(Some("pt-BR")).extension_title, "Selecionar extensão");
        assert_eq!(browser_dialog_copy(Some("en")).download_title, "Save shared browser download");
    }
}
