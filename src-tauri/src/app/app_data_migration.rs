use std::{fs, io, path::Path};

/// Copy before WebView2 opens its profile. Retain the old directory for recovery.
fn migrate_directory(source: &Path, destination: &Path) -> io::Result<()> {
    if destination.exists() || !source.exists() { return Ok(()); }
    let staging = destination.with_extension("migration");
    copy_directory(source, &staging)?;
    fs::rename(staging, destination)
}

fn copy_directory(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() { continue; }
        let target = destination.join(entry.file_name());
        if kind.is_dir() { copy_directory(&entry.path(), &target)?; }
        else if kind.is_file() { fs::copy(entry.path(), target)?; }
    }
    Ok(())
}

pub fn migrate_legacy_data() -> io::Result<()> {
    #[cfg(windows)]
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        let base = std::path::PathBuf::from(base);
        migrate_directory(&base.join("com.p2sharer.app"), &base.join("com.p2sharer.desktop"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_preserves_nested_data_and_never_overwrites_new_profile() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("p2sharer-migration-{}-{unique}", std::process::id()));
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(old.join("rooms")).unwrap();
        fs::write(old.join("rooms/saved.json"), b"saved room fixture").unwrap();
        migrate_directory(&old, &new).unwrap();
        assert_eq!(fs::read(new.join("rooms/saved.json")).unwrap(), b"saved room fixture");
        assert!(old.join("rooms/saved.json").exists());
        fs::write(new.join("rooms/saved.json"), b"new settings").unwrap();
        migrate_directory(&old, &new).unwrap();
        assert_eq!(fs::read(new.join("rooms/saved.json")).unwrap(), b"new settings");
        migrate_directory(&root.join("absent"), &root.join("unused")).unwrap();
        assert!(!root.join("unused").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
