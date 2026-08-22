use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_FILE: Mutex<Option<File>> = Mutex::new(None);
static LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn get_log_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    base.join("p2sharer").join("logs")
}

pub fn init_logger() {
    let log_dir = get_log_dir();
    let _ = fs::create_dir_all(&log_dir);

    let latest_path = log_dir.join("latest.log");
    let previous_path = log_dir.join("previous.log");

    // Rotate previous log
    if latest_path.exists() {
        let _ = fs::remove_file(&previous_path);
        let _ = fs::rename(&latest_path, &previous_path);
    }

    match OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&latest_path)
    {
        Ok(mut file) => {
            let start_time = get_timestamp();
            let header = format!(
                "================================================================================\r\n\
                 P2Sharer Execution & Diagnostics Log (latest.log)\r\n\
                 Session Started: {}\r\n\
                 OS: Windows (Architecture: {})\r\n\
                 App Version: 1.0.0\r\n\
                 Log File: {}\r\n\
                 ================================================================================\r\n\r\n",
                start_time,
                std::env::consts::ARCH,
                latest_path.to_string_lossy()
            );
            let _ = file.write_all(header.as_bytes());
            let _ = file.flush();

            if let Ok(mut lock) = LOG_FILE.lock() {
                *lock = Some(file);
            }
            if let Ok(mut lock) = LOG_PATH.lock() {
                *lock = Some(latest_path.clone());
            }
        }
        Err(e) => {
            eprintln!("[LOGGER] Failed to initialize log file: {}", e);
        }
    }

    // Set custom panic hook to capture crash stacktraces
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
            "\r\n[{}][FATAL PANIC] Location: {}\r\nPayload: {}\r\nBacktrace:\r\n{:?}\r\n",
            timestamp,
            location,
            payload,
            std::backtrace::Backtrace::capture()
        );

        log_raw(&panic_msg);
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
            let _ = file.flush();
        }
    }
}

pub fn log_msg(level: &str, target: &str, message: &str) {
    let timestamp = get_timestamp();
    let line = format!("[{}][{:5}][{}] {}\r\n", timestamp, level, target, message);
    print!("{}", line);
    log_raw(&line);
}

#[tauri::command]
pub fn write_frontend_log(level: String, message: String, context: Option<String>) {
    let target = context.as_deref().unwrap_or("frontend");
    log_msg(&level.to_uppercase(), target, &message);
}

#[tauri::command]
pub fn get_log_file_path() -> String {
    if let Ok(lock) = LOG_PATH.lock() {
        if let Some(ref p) = *lock {
            return p.to_string_lossy().to_string();
        }
    }
    get_log_dir().join("latest.log").to_string_lossy().to_string()
}

#[tauri::command]
pub fn open_log_folder() -> Result<(), String> {
    let log_dir = get_log_dir();
    let latest_path = log_dir.join("latest.log");

    if latest_path.exists() {
        // Select the file in Windows Explorer
        let _ = std::process::Command::new("explorer.exe")
            .arg(format!("/select,\"{}\"", latest_path.to_string_lossy()))
            .spawn();
    } else {
        let _ = std::process::Command::new("explorer.exe")
            .arg(log_dir.to_string_lossy().to_string())
            .spawn();
    }
    Ok(())
}

#[tauri::command]
pub fn open_latest_log() -> Result<(), String> {
    let latest_path = get_log_dir().join("latest.log");
    if !latest_path.exists() {
        return Err("Arquivo de log ainda não foi criado.".into());
    }

    // Open directly with Notepad or default viewer
    let _ = std::process::Command::new("notepad.exe")
        .arg(latest_path.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| format!("Falha ao abrir o bloco de notas: {}", e))?;

    Ok(())
}
