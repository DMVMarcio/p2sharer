//! Keep Win32 workspace placement separate from transient fullscreen geometry.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::Path, sync::{LazyLock, Mutex}};
use tauri::Manager;
use windows::Win32::{Foundation::{HWND, RECT}, UI::WindowsAndMessaging::{
    GetWindowPlacement, SetWindowPlacement, SetWindowPos, WINDOWPLACEMENT,
    SW_SHOWMAXIMIZED, SW_SHOWNORMAL, SW_SHOWMINIMIZED, SW_MINIMIZE, WPF_RESTORETOMAXIMIZED,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
}};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Placement { x: i32, y: i32, width: i32, height: i32, maximized: bool }
impl Placement {
    fn valid(&self) -> bool {
        self.x.unsigned_abs() <= 1_000_000 && self.y.unsigned_abs() <= 1_000_000
            && (100..=65536).contains(&self.width) && (100..=65536).contains(&self.height)
    }
    fn native(&self, maximized: bool) -> WINDOWPLACEMENT {
        WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            showCmd: if maximized { SW_SHOWMAXIMIZED.0 as u32 } else { SW_SHOWNORMAL.0 as u32 },
            rcNormalPosition: RECT { left: self.x, top: self.y, right: self.x + self.width, bottom: self.y + self.height },
            ..Default::default()
        }
    }
}

#[derive(Default)]
struct PlacementState { normal: Option<Placement>, fullscreen: HashMap<String, Placement> }
impl PlacementState {
    fn remembered(&self) -> Option<Placement> { self.fullscreen.get("main").cloned().or_else(|| self.normal.clone()) }
}
static STATE: LazyLock<Mutex<PlacementState>> = LazyLock::new(|| Mutex::new(PlacementState::default()));

fn capture(hwnd: HWND) -> Result<Placement, String> {
    let mut value = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
    unsafe { GetWindowPlacement(hwnd, &mut value).map_err(|e| e.to_string())?; }
    let rect = value.rcNormalPosition;
    let minimized = value.showCmd == SW_SHOWMINIMIZED.0 as u32 || value.showCmd == SW_MINIMIZE.0 as u32;
    let placement = Placement { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top,
        maximized: value.showCmd == SW_SHOWMAXIMIZED.0 as u32 || minimized && value.flags.0 & WPF_RESTORETOMAXIMIZED.0 != 0 };
    if !placement.valid() { return Err("Invalid window placement".into()); }
    Ok(placement)
}

fn restore(hwnd: HWND, placement: &Placement) -> Result<(), String> {
    if !placement.valid() { return Err("Invalid window placement".into()); }
    unsafe {
        // A normal -> maximized transition makes Windows recompute the nonclient frame,
        // rather than retaining a maximized frame sized for a fullscreen monitor.
        SetWindowPlacement(hwnd, &placement.native(false)).map_err(|e| e.to_string())?;
        if placement.maximized { SetWindowPlacement(hwnd, &placement.native(true)).map_err(|e| e.to_string())?; }
        SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn read_saved(path: &Path) -> Option<Placement> {
    if fs::metadata(path).ok()?.len() > 4096 { return None; }
    let placement: Placement = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    placement.valid().then_some(placement)
}
fn write_saved(path: &Path, placement: &Placement) -> Result<(), String> {
    if !placement.valid() { return Err("Invalid window placement".into()); }
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, serde_json::to_vec(placement).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())
}
fn saved_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory.join("window-placement.json"))
}

pub fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    if let Some(placement) = read_saved(&saved_path(window.app_handle())?) {
        restore(HWND(window.hwnd().map_err(|e| e.to_string())?.0), &placement)?;
    }
    let placement = capture(HWND(window.hwnd().map_err(|e| e.to_string())?.0))?;
    STATE.lock().map_err(|e| e.to_string())?.normal = Some(placement);
    Ok(())
}

pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        if matches!(event, tauri::WindowEvent::Destroyed) { if let Ok(mut state) = STATE.lock() { state.fullscreen.remove(window.label()); } }
        return;
    }
    if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
        let tracked = STATE.lock().ok().is_some_and(|state| state.normal.is_some() && !state.fullscreen.contains_key("main"));
        if tracked {
            if let Ok(placement) = window.hwnd().map_err(|e| e.to_string()).and_then(|hwnd| capture(HWND(hwnd.0))) {
                if let Ok(mut state) = STATE.lock() { state.normal = Some(placement); }
            }
        }
    }
    if matches!(event, tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed) {
        let saved = STATE.lock().ok().and_then(|state| state.remembered());
        if let Some(saved) = saved {
            if let Err(error) = saved_path(window.app_handle()).and_then(|path| write_saved(&path, &saved)) {
                eprintln!("[Window] Could not persist placement: {error}");
            }
        }
    }
}

fn authorize(window: &tauri::Window) -> Result<(), String> {
    if window.label() == "main" || window.label().starts_with("pip-") { Ok(()) }
    else { Err("Only application windows can manage placement".into()) }
}

#[tauri::command]
pub async fn capture_window_placement(window: tauri::Window) -> Result<Placement, String> {
    authorize(&window)?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    let label = window.label().to_owned();
    let (send, receive) = tokio::sync::oneshot::channel();
    window.run_on_main_thread(move || {
        let result = capture(HWND(hwnd as *mut _)).and_then(|placement| {
            let mut state = STATE.lock().map_err(|e| e.to_string())?;
            Ok(state.fullscreen.entry(label).or_insert(placement).clone())
        });
        let _ = send.send(result);
    }).map_err(|e| e.to_string())?;
    receive.await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn restore_window_placement(window: tauri::Window, placement: Placement) -> Result<(), String> {
    authorize(&window)?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    let label = window.label().to_owned();
    let (send, receive) = tokio::sync::oneshot::channel();
    window.run_on_main_thread(move || {
        let result = restore(HWND(hwnd as *mut _), &placement).and_then(|_| {
            let mut state = STATE.lock().map_err(|e| e.to_string())?;
            if label == "main" { state.normal = Some(placement); }
            state.fullscreen.remove(&label);
            Ok(())
        });
        let _ = send.send(result);
    }).map_err(|e| e.to_string())?;
    receive.await.map_err(|e| e.to_string())?
}


#[cfg(test)]
mod tests {
    use super::*;
    fn placement() -> Placement { Placement { x: -1200, y: 80, width: 1100, height: 700, maximized: true } }
    #[test]
    fn placement_round_trips_workspace_coordinates_and_show_state_without_client_frame_conversion() {
        let saved = placement();
        let native = saved.native(saved.maximized);
        assert_eq!(native.length as usize, std::mem::size_of::<WINDOWPLACEMENT>());
        assert_eq!(native.rcNormalPosition.left, -1200);
        assert_eq!(native.rcNormalPosition.right - native.rcNormalPosition.left, 1100);
        assert_eq!(native.rcNormalPosition.bottom - native.rcNormalPosition.top, 700);
        assert_eq!(native.showCmd, SW_SHOWMAXIMIZED.0 as u32);
    }
    #[test]
    fn closing_during_fullscreen_remembers_the_windowed_snapshot() {
        let original = placement();
        let mut state = PlacementState { normal: Some(original.clone()), ..Default::default() };
        state.fullscreen.insert("main".into(), original.clone());
        state.normal = Some(Placement { x: 0, y: 0, width: 3840, height: 2160, maximized: false });
        assert_eq!(state.remembered(), Some(original.clone()));
        state.normal = Some(original.clone()); state.fullscreen.clear();
        assert_eq!(state.remembered(), Some(original));
    }
    #[test]
    fn persisted_placement_reopens_and_corrupt_or_invalid_files_use_defaults() {
        let path = std::env::temp_dir().join(format!("p2sharer-window-placement-{}-{}.json", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        write_saved(&path, &placement()).unwrap();
        assert_eq!(read_saved(&path), Some(placement()));
        write_saved(&path, &Placement { maximized: false, ..placement() }).unwrap();
        assert!(!read_saved(&path).unwrap().maximized);
        fs::write(&path, b"invalid").unwrap(); assert_eq!(read_saved(&path), None);
        assert!(write_saved(&path, &Placement { width: 0, ..placement() }).is_err());
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn native_capture_initializes_the_windows_structure_and_reads_a_hidden_window() {
        use windows::{core::w, Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, IsWindowVisible, WS_OVERLAPPEDWINDOW, WS_EX_TOOLWINDOW}};
        unsafe {
            let hwnd = CreateWindowExW(WS_EX_TOOLWINDOW, w!("STATIC"), w!("Placement fixture"), WS_OVERLAPPEDWINDOW,
                100, 100, 480, 320, None, None, None, None).unwrap();
            let result = capture(hwnd);
            let visible = IsWindowVisible(hwnd).as_bool();
            DestroyWindow(hwnd).unwrap();
            let saved = result.unwrap();
            assert_eq!((saved.width, saved.height), (480, 320));
            assert!(!visible);
        }
    }
}
