use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_FILE: Mutex<Option<File>> = Mutex::new(None);
static LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);
const MAX_SESSION_LOGS: usize = 8;
struct NativeLogger;
static NATIVE_LOGGER: NativeLogger = NativeLogger;

impl log::Log for NativeLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool { metadata.level() <= log::Level::Warn }
    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            log_msg(record.level().as_str(), record.target(), &format!("{} ({}:{})", record.args(),
                record.file().unwrap_or("unknown"), record.line().unwrap_or(0)));
        }
    }
    fn flush(&self) { flush_log(); }
}

fn session_log_started_at(path: &Path) -> Option<u128> {
    let name = path.file_name()?.to_str()?;
    let stem = name.strip_prefix("session-")?.strip_suffix(".log")?;
    let (started_at, pid) = stem.split_once('-')?;
    if !started_at.bytes().all(|byte| byte.is_ascii_digit())
        || !pid.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    pid.parse::<u32>().ok()?;
    started_at.parse::<u128>().ok()
}

fn rotate_session_logs(log_dir: &Path, current_path: &Path) -> std::io::Result<()> {
    let mut logs = fs::read_dir(log_dir)?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().ok()?.is_file() {
                return None;
            }
            let path = entry.path();
            let started_at = session_log_started_at(&path)?;
            Some((started_at, entry.file_name(), path))
        })
        .collect::<Vec<_>>();

    logs.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let mut excess = logs.len().saturating_sub(MAX_SESSION_LOGS);
    for (_, _, path) in logs {
        if excess == 0 {
            break;
        }
        if path == current_path {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => excess -= 1,
            Err(error) => eprintln!(
                "[LOGGER] Failed to remove old session log {}: {}",
                path.display(),
                error
            ),
        }
    }
    Ok(())
}

pub fn get_log_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    base.join("p2sharer").join("logs")
}

fn write_log_header(file: &mut File, path: &Path, event: &str) -> std::io::Result<()> {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let header = format!(
        "================================================================================\r\n\
         P2Sharer Execution & Diagnostics Log ({})\r\n\
         {}: {}\r\n\
         OS: Windows (Architecture: {})\r\n\
         App Version: {} (debug={})\r\n\
         Log File: {}\r\n\
         ================================================================================\r\n\r\n",
        name,
        event,
        get_timestamp(),
        std::env::consts::ARCH,
        env!("CARGO_PKG_VERSION"),
        cfg!(debug_assertions),
        path.to_string_lossy()
    );
    file.write_all(header.as_bytes())?;
    file.flush()
}

fn current_log_path() -> Result<PathBuf, String> {
    LOG_PATH
        .lock()
        .map_err(|_| "Não foi possível acessar o caminho do log.".to_string())?
        .clone()
        .ok_or_else(|| "Arquivo de log ainda não foi criado.".to_string())
}

pub fn init_logger() {
    let log_dir = get_log_dir();
    let _ = fs::create_dir_all(&log_dir);

    let started_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let session_path = log_dir.join(format!("session-{}-{}.log", started_at, std::process::id()));

    match OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&session_path)
    {
        Ok(mut file) => {
            let _ = write_log_header(&mut file, &session_path, "Session Started");

            if let Ok(mut lock) = LOG_FILE.lock() {
                *lock = Some(file);
            }
            if let Ok(mut lock) = LOG_PATH.lock() {
                *lock = Some(session_path.clone());
            }
            if let Err(error) = rotate_session_logs(&log_dir, &session_path) {
                eprintln!("[LOGGER] Failed to rotate session logs: {}", error);
            }
        }
        Err(e) => {
            eprintln!("[LOGGER] Failed to initialize log file: {}", e);
        }
    }

    if log::set_logger(&NATIVE_LOGGER).is_ok() { log::set_max_level(log::LevelFilter::Warn); }

    // Preserve panic traces in release builds even without RUST_BACKTRACE.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let timestamp = get_timestamp();
        let payload = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic payload".to_string()
        };

        let location = if let Some(loc) = panic_info.location() {
            format!("{}:{}:{}", loc.file(), loc.line(), loc.column())
        } else {
            "Unknown location".to_string()
        };

        let panic_msg = format!(
            "\r\n[{}][FATAL PANIC] Location: {}\r\nThread: {:?}\r\nPayload: {}\r\nBacktrace:\r\n{:?}\r\n",
            timestamp,
            location,
            std::thread::current().name(),
            payload,
            std::backtrace::Backtrace::force_capture()
        );

        log_raw(&panic_msg);
        flush_log();
        default_hook(panic_info);
    }));

    log_msg("INFO", "system", "P2Sharer diagnostics logger initialized successfully.");
}

fn get_timestamp() -> String {
    let now = SystemTime::now();
    let duration = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = duration.as_secs();
    let millis = duration.subsec_millis();

    let days = secs / 86400;
    let rem_secs = secs % 86400;
    let hours = (rem_secs / 3600) % 24;
    let minutes = (rem_secs / 60) % 60;
    let seconds = rem_secs % 60;

    // Approximate UTC YYYY-MM-DD
    let mut year = 1970;
    let mut d = days;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
        let days_in_year = if leap { 366 } else { 365 };
        if d < days_in_year {
            break;
        }
        d -= days_in_year;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    let days_in_months = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1;
    for &dim in &days_in_months {
        if d < dim {
            break;
        }
        d -= dim;
        month += 1;
    }
    let day = d + 1;

    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03} UTC",
        year, month, day, hours, minutes, seconds, millis
    )
}

pub fn log_raw(content: &str) {
    if let Ok(mut lock) = LOG_FILE.lock() {
        if let Some(ref mut file) = *lock {
            let _ = file.write_all(content.as_bytes());
        }
    }
}

pub fn log_msg(level: &str, target: &str, message: &str) {
    let timestamp = get_timestamp();
    let line = format!("[{}][{:5}][{}] {}\r\n", timestamp, level, target, message);
    print!("{}", line);
    log_raw(&line);
    if matches!(level, "WARN" | "ERROR" | "FATAL") { flush_log(); }
}

#[tauri::command]
pub fn write_frontend_log(level: String, message: String, context: Option<String>) {
    let target = context.as_deref().unwrap_or("frontend");
    log_msg(&level.to_uppercase(), target, &message);
}

#[tauri::command]
pub fn get_log_file_path() -> String {
    current_log_path()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
}

pub fn flush_log() {
    if let Ok(mut lock) = LOG_FILE.lock() {
        if let Some(ref mut file) = *lock {
            let _ = file.flush();
        }
    }
}

#[tauri::command]
pub fn open_log_folder() -> Result<(), String> {
    flush_log();
    let log_dir = get_log_dir();
    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("Falha ao acessar a pasta de logs: {}", error))?;
    // Command handles path quoting; embedded quotes confuse Explorer's argument parser.
    std::process::Command::new("explorer.exe")
        .arg(&log_dir)
        .spawn()
        .map_err(|error| format!("Falha ao abrir a pasta de logs: {}", error))?;
    Ok(())
}

#[tauri::command]
pub fn open_latest_log() -> Result<(), String> {
    flush_log();
    let current_path = current_log_path()?;
    if !current_path.exists() {
        return Err("Arquivo de log ainda não foi criado.".into());
    }

    // Open directly with Notepad or default viewer
    let _ = std::process::Command::new("notepad.exe")
        .arg(current_path.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| format!("Falha ao abrir o bloco de notas: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn clear_log_file() -> Result<(), String> {
    let path = current_log_path()?;
    {
        let mut lock = LOG_FILE.lock().map_err(|_| "Não foi possível acessar o log.".to_string())?;
        let file = lock.as_mut().ok_or_else(|| "Arquivo de log ainda não foi criado.".to_string())?;
        file.set_len(0).map_err(|e| format!("Falha ao limpar arquivo de log: {}", e))?;
        file.seek(SeekFrom::Start(0)).map_err(|e| format!("Falha ao reiniciar o log: {}", e))?;
        write_log_header(file, &path, "Log Cleared")
            .map_err(|e| format!("Falha ao reescrever o log: {}", e))?;
    }
    log_msg("INFO", "system", "Log file cleared by user request.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_errors_and_version_header_are_written_to_the_session_file() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("p2sharer-logger-test-{unique}.log"));
        let mut file = File::create(&path).unwrap();
        write_log_header(&mut file, &path, "Test Session").unwrap();
        let previous = LOG_FILE.lock().unwrap().replace(file);
        log::Log::log(&NATIVE_LOGGER, &log::Record::builder()
            .args(format_args!("Native test failure code=42"))
            .level(log::Level::Error).target("test.native").file(Some("fixture.rs")).line(Some(12)).build());
        *LOG_FILE.lock().unwrap() = previous;
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains(&format!("App Version: {}", env!("CARGO_PKG_VERSION"))));
        assert!(text.contains("[ERROR][test.native] Native test failure code=42 (fixture.rs:12)"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn rotation_keeps_eight_newest_session_logs_and_unrelated_files() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let log_dir = std::env::temp_dir().join(format!("p2sharer-log-rotation-{unique}"));
        fs::create_dir(&log_dir).unwrap();

        // Create in reverse order so file modification time cannot decide retention.
        for started_at in (1..=10).rev() {
            File::create(log_dir.join(format!("session-{started_at}-123.log"))).unwrap();
        }
        File::create(log_dir.join("notes.txt")).unwrap();
        File::create(log_dir.join("session-invalid-123.log")).unwrap();

        let current_path = log_dir.join("session-10-123.log");
        rotate_session_logs(&log_dir, &current_path).unwrap();

        let remaining = fs::read_dir(&log_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| session_log_started_at(&entry.path()))
            .collect::<Vec<_>>();
        assert_eq!(remaining.len(), MAX_SESSION_LOGS);
        for started_at in 1..=10 {
            assert_eq!(
                log_dir
                    .join(format!("session-{started_at}-123.log"))
                    .exists(),
                started_at >= 3
            );
        }
        assert!(log_dir.join("notes.txt").exists());
        assert!(log_dir.join("session-invalid-123.log").exists());

        fs::remove_dir_all(log_dir).unwrap();
    }
}
