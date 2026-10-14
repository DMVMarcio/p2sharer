//! Import explicitly selected packages into the browser profile; never retain source paths.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::{Read, Write}, path::{Component, Path, PathBuf}};
const INVALID: &str = "Could not open extension package";
const LIMIT: &str = "Extension package exceeds size limit";
const MAX_FILE: u64 = 32 * 1024 * 1024;
const MAX_TOTAL: u64 = 200 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone)]
pub struct Package { pub directory: PathBuf, pub popup: Option<String> }
pub type Registry = BTreeMap<String, Package>;
pub fn registry(profile: &Path) -> Registry {
    fs::read(profile.join("p2sharer-extensions.json")).ok().filter(|b| b.len() <= 1024 * 1024)
        .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
pub fn remember(profile: &Path, id: String, package: Package) -> Result<(), String> {
    let mut entries = registry(profile); entries.insert(id, package);
    if entries.len() > 100 { return Err(LIMIT.into()); }
    write_registry(profile, &entries)
}
fn write_registry(profile: &Path, entries: &Registry) -> Result<(), String> {
    let bytes = serde_json::to_vec(&entries).map_err(|e| e.to_string())?;
    let path = profile.join("p2sharer-extensions.json");
    fs::write(path.with_extension("tmp"), bytes).map_err(|e| e.to_string())?;
    fs::rename(path.with_extension("tmp"), path).map_err(|e| e.to_string())
}
pub fn forget(profile: &Path, id: &str) -> Result<(), String> {
    let mut entries = registry(profile);
    let Some(package) = entries.remove(id) else { return Ok(()); };
    write_registry(profile, &entries)?;
    let base = fs::canonicalize(profile.join("P2SharerExtensions")).map_err(|_| INVALID)?;
    if let Ok(path) = fs::canonicalize(package.directory) {
        if let Ok(relative) = path.strip_prefix(&base) {
            if let Some(Component::Normal(root)) = relative.components().next() {
                if root.to_string_lossy().starts_with("package-") {
                    let target = fs::canonicalize(base.join(root)).map_err(|_| INVALID)?;
                    if target.starts_with(&base) && target != base { fs::remove_dir_all(target).map_err(|_| INVALID)?; }
                }
            }
        }
    }
    Ok(())
}
fn safe_path(path: &Path) -> bool {
    !path.as_os_str().is_empty() && !path.to_string_lossy().contains('\\') && path.components().count() <= 32 && path.components().all(|part| {
        let Component::Normal(name) = part else { return false; };
        let name = name.to_string_lossy();
        let device = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        !name.contains([':', '\\']) && !name.ends_with(['.', ' '])
            && !matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
            && !device.strip_prefix("COM").or_else(|| device.strip_prefix("LPT"))
                .is_some_and(|suffix| suffix.chars().count() == 1 && "123456789¹²³".contains(suffix))
    })
}
fn copy<R: Read>(mut source: R, target: &Path, declared: u64, total: &mut u64) -> Result<(), String> {
    if declared > MAX_FILE || *total + declared > MAX_TOTAL { return Err(LIMIT.into()); }
    fs::create_dir_all(target.parent().ok_or(INVALID)?).map_err(|_| INVALID)?;
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(target).map_err(|_| INVALID)?;
    let count = std::io::copy(&mut source.by_ref().take(MAX_FILE + 1), &mut output).map_err(|_| INVALID)?;
    *total += count;
    if count > MAX_FILE || *total > MAX_TOTAL { return Err(LIMIT.into()); }
    output.flush().map_err(|_| INVALID)?; Ok(())
}
fn copy_folder(source: &Path, target: &Path, total: &mut u64, count: &mut usize, depth: usize) -> Result<(), String> {
    if depth > 32 { return Err(LIMIT.into()); }
    for entry in fs::read_dir(source).map_err(|_| INVALID)? {
        let entry = entry.map_err(|_| INVALID)?; *count += 1;
        if *count > 10000 { return Err(LIMIT.into()); }
        if !safe_path(Path::new(&entry.file_name())) { return Err(INVALID.into()); }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| INVALID)?;
        if metadata.file_type().is_symlink() { return Err(INVALID.into()); }
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 { return Err(INVALID.into()); }
        }
        let destination = target.join(entry.file_name());
        if metadata.is_dir() { copy_folder(&entry.path(), &destination, total, count, depth + 1)?; }
        else if metadata.is_file() { copy(fs::File::open(entry.path()).map_err(|_| INVALID)?, &destination, metadata.len(), total)?; }
        else { return Err(INVALID.into()); }
    }
    Ok(())
}
fn archive_payload(bytes: &[u8]) -> Result<&[u8], String> {
    if !bytes.starts_with(b"Cr24") { return Ok(bytes); }
    let number = |offset: usize| -> Result<usize, String> {
        Ok(u32::from_le_bytes(bytes.get(offset..offset+4).ok_or(INVALID)?.try_into().map_err(|_| INVALID)?) as usize)
    };
    let offset = match number(4)? {
        2 => 16usize.checked_add(number(8)?).and_then(|v| v.checked_add(number(12).ok()?)),
        3 => 12usize.checked_add(number(8)?),
        _ => None,
    }.ok_or(INVALID)?;
    bytes.get(offset..).filter(|b| b.starts_with(b"PK")).ok_or_else(|| INVALID.into())
}
fn unpack(source: &Path, target: &Path, total: &mut u64) -> Result<(), String> {
    if fs::metadata(source).map_err(|_| INVALID)?.len() > 64 * 1024 * 1024 { return Err(LIMIT.into()); }
    let bytes = fs::read(source).map_err(|_| INVALID)?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(archive_payload(&bytes)?)).map_err(|_| INVALID)?;
    if archive.len() > 10000 { return Err(LIMIT.into()); }
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| INVALID)?;
        let path = entry.enclosed_name().filter(|p| safe_path(p)).ok_or(INVALID)?;
        if entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) { return Err(INVALID.into()); }
        if entry.is_dir() { fs::create_dir_all(target.join(path)).map_err(|_| INVALID)?; }
        else { let size = entry.size(); copy(&mut entry, &target.join(path), size, total)?; }
    }
    Ok(())
}
fn manifest_root(directory: &Path) -> Result<PathBuf, String> {
    if directory.join("manifest.json").is_file() { return Ok(directory.into()); }
    let children: Vec<_> = fs::read_dir(directory).map_err(|_| INVALID)?.filter_map(Result::ok)
        .filter(|e| e.path().is_dir() && e.path().join("manifest.json").is_file()).collect();
    if children.len() == 1 { Ok(children[0].path()) } else { Err(INVALID.into()) }
}
pub fn import(source: &Path, profile: &Path) -> Result<Package, String> {
    let source = fs::canonicalize(source).map_err(|_| INVALID)?;
    let base = profile.join("P2SharerExtensions"); fs::create_dir_all(&base).map_err(|_| INVALID)?;
    let owned = fs::canonicalize(&base).map_err(|_| INVALID)?;
    if !owned.starts_with(fs::canonicalize(profile).map_err(|_| INVALID)?) || owned.starts_with(&source) { return Err(INVALID.into()); }
    let mut unique = [0u8; 16]; getrandom::getrandom(&mut unique).map_err(|_| INVALID)?;
    let directory = base.join(format!("package-{:032x}", u128::from_le_bytes(unique)));
    fs::create_dir(&directory).map_err(|_| INVALID)?;
    let result = (|| {
        let mut total = 0;
        if source.is_dir() { copy_folder(&source, &directory, &mut total, &mut 0, 0)?; }
        else { unpack(&source, &directory, &mut total)?; }
        let directory = manifest_root(&directory)?;
        let bytes = fs::read(directory.join("manifest.json")).map_err(|_| INVALID)?;
        if bytes.len() > 1024 * 1024 { return Err(LIMIT.into()); }
        let manifest: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
        if !matches!(manifest["manifest_version"].as_u64(), Some(2 | 3)) || !manifest["name"].is_string() { return Err(INVALID.into()); }
        let popup = ["action", "browser_action", "page_action"].iter().find_map(|key| manifest[key]["default_popup"].as_str())
            .filter(|path| safe_path(Path::new(path)) && directory.join(path).is_file()).map(str::to_owned);
        Ok(Package { directory, popup })
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&directory); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zip_import_is_owned_persistent_and_rejects_traversal() {
        let mut unique = [0;16]; getrandom::getrandom(&mut unique).unwrap();
        let directory = std::env::temp_dir().join(format!("p2sharer-extension-fixture-{:032x}", u128::from_le_bytes(unique)));
        struct Cleanup(PathBuf); impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        fs::create_dir(&directory).unwrap(); let _cleanup = Cleanup(directory.clone());
        let profile = directory.join("profile"); fs::create_dir(&profile).unwrap();
        let source = directory.join("extension.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&source).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/manifest.json", options).unwrap();
        zip.write_all(br#"{"manifest_version":3,"name":"Fixture","version":"1","action":{"default_popup":"popup.html"}}"#).unwrap();
        zip.start_file("extension/popup.html", options).unwrap(); zip.write_all(b"<p>Fixture</p>").unwrap(); zip.finish().unwrap();
        let package = import(&source, &profile).unwrap();
        assert_eq!(package.popup.as_deref(), Some("popup.html"));
        remember(&profile, "fixture".into(), package.clone()).unwrap(); fs::remove_file(&source).unwrap();
        assert!(registry(&profile)["fixture"].directory.join("popup.html").is_file());
        forget(&profile, "fixture").unwrap(); assert!(!package.directory.exists());
        let mut zip = zip::ZipWriter::new(fs::File::create(&source).unwrap());
        zip.start_file("../escaped.txt", options).unwrap(); zip.write_all(b"fixture").unwrap(); zip.finish().unwrap();
        assert!(import(&source, &profile).is_err()); assert!(!directory.join("escaped.txt").exists());
    }
    #[test]
    fn package_paths_and_crx_headers_cannot_escape_the_owned_directory() {
        for path in ["../outside", "C:/outside", "CON.js", "CONOUT$", "COM¹.txt", "folder/file:stream", "file.", "folder\\outside"] {
            assert!(!safe_path(Path::new(path)), "{path}");
        }
        assert!(safe_path(Path::new("scripts/popup.html")));
        assert!(archive_payload(b"Cr24\x03\0\0\0\xff\xff\xff\xff").is_err());
        let mut crx = b"Cr24\x03\0\0\0\0\0\0\0".to_vec(); crx.extend(b"PKtest");
        assert_eq!(archive_payload(&crx).unwrap(), b"PKtest");
    }
}
