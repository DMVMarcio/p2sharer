use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, LazyLock, Mutex,
};
use tauri::{AppHandle, Emitter};

const VIGEMBUS_INSTALLER_URL: &str =
    "https://github.com/nefarius/ViGEmBus/releases/download/v1.22.0/ViGEmBus_1.22.0_x64_x86_arm64.exe";
const VIGEMBUS_INSTALLER_FILENAME: &str = "ViGEmBus_1.22.0_x64_x86_arm64.exe";
const VIGEMBUS_INSTALLER_SHA256: &str =
    "89220a7865076b342892f98865f3499fb7c4cfd673159e89d352c360fd014c6a";
const VIGEMBUS_MAX_DOWNLOAD_BYTES: usize = 32 * 1024 * 1024;
const MISSING_DRIVER_NOTIFY_INTERVAL_MS: u64 = 30_000;

static DRIVER_INSTALL_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GamepadDriverInstallStagePayload {
    pub stage: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GamepadDriverInstallResult {
    pub status: String,
    pub driver_available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallerExitOutcome {
    Success,
    RebootRequired,
    Cancelled,
}

pub fn verify_sha256_hex(bytes: &[u8], expected_hex: &str) -> Result<(), String> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let actual_hex: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if actual_hex.eq_ignore_ascii_case(expected_hex) {
        Ok(())
    } else {
        Err(format!(
            "Downloaded installer checksum mismatch (expected {expected_hex}, got {actual_hex})"
        ))
    }
}

fn classify_installer_exit_code(exit_code: u32) -> Result<InstallerExitOutcome, String> {
    match exit_code {
        0 => Ok(InstallerExitOutcome::Success),
        1641 | 3010 => Ok(InstallerExitOutcome::RebootRequired),
        1223 | 1602 => Ok(InstallerExitOutcome::Cancelled),
        other => Err(format!(
            "ViGEmBus installer exited with Windows installer code {other}"
        )),
    }
}

fn emit_driver_install_stage(app: &AppHandle, stage: &str) {
    let _ = app.emit_to(
        "main",
        "remote-control-gamepad-driver-install",
        GamepadDriverInstallStagePayload {
            stage: stage.to_string(),
        },
    );
}

fn emit_missing_driver_needed() {
    if let Ok(guard) = APP_HANDLE_CELL.lock() {
        if let Some(app) = guard.as_ref() {
            let _ = app.emit_to("main", "remote-control-gamepad-driver-needed", ());
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GamepadWireState {
    pub buttons: u16,
    pub left_trigger: u8,
    pub right_trigger: u8,
    pub thumb_lx: i16,
    pub thumb_ly: i16,
    pub thumb_rx: i16,
    pub thumb_ry: i16,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VirtualGamepadSlotSnapshot {
    pub id: String,
    pub controller_id: String,
    pub peer_id: String,
    pub media_id: String,
    pub pad_index: u8,
    pub order: usize,
    pub xinput_slot: Option<u32>,
    pub connected_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VirtualGamepadsStatePayload {
    pub driver_available: bool,
    pub gamepads: Vec<VirtualGamepadSlotSnapshot>,
}

static APP_HANDLE_CELL: LazyLock<Mutex<Option<AppHandle>>> = LazyLock::new(|| Mutex::new(None));
static LAST_SNAPSHOT: LazyLock<Mutex<VirtualGamepadsStatePayload>> = LazyLock::new(|| {
    Mutex::new(VirtualGamepadsStatePayload {
        driver_available: false,
        gamepads: Vec::new(),
    })
});

pub fn set_app_handle(app: &AppHandle) {
    if let Ok(mut guard) = APP_HANDLE_CELL.lock() {
        *guard = Some(app.clone());
    }
}

fn emit_snapshot(app_override: Option<&AppHandle>, snapshot: VirtualGamepadsStatePayload) {
    let changed = if let Ok(mut guard) = LAST_SNAPSHOT.lock() {
        if *guard == snapshot {
            false
        } else {
            *guard = snapshot.clone();
            true
        }
    } else {
        true
    };
    if !changed {
        return;
    }
    if let Some(app) = app_override {
        let _ = app.emit_to("main", "remote-control-gamepads-changed", snapshot);
        return;
    }
    if let Ok(guard) = APP_HANDLE_CELL.lock() {
        if let Some(app) = guard.as_ref() {
            let _ = app.emit_to("main", "remote-control-gamepads-changed", snapshot);
        }
    }
}

pub fn make_slot_id(peer_id: &str, media_id: &str, pad_index: u8) -> String {
    format!("{peer_id}:{media_id}:{pad_index}")
}

/// Computes a sanitized ordered permutation matching the requested ID list, appending any active
/// slots not named in `ordered_ids` in their original relative order.
pub fn compute_reordered_positions(current_ids: &[String], ordered_ids: &[String]) -> Vec<usize> {
    let mut result = Vec::with_capacity(current_ids.len());
    let mut used = vec![false; current_ids.len()];
    for wanted in ordered_ids {
        if let Some(idx) = current_ids.iter().position(|id| id == wanted) {
            if !used[idx] {
                used[idx] = true;
                result.push(idx);
            }
        }
    }
    for (idx, flag) in used.into_iter().enumerate() {
        if !flag {
            result.push(idx);
        }
    }
    result
}

#[cfg(windows)]
mod win_impl {
    use super::*;
    use std::collections::HashMap;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::time::{SystemTime, UNIX_EPOCH};
    use vigem_client::{Client, TargetId, XButtons, XGamepad, Xbox360Wired};

    const MAX_VIRTUAL_GAMEPADS: usize = 16;

    enum WorkerCmd {
        Update {
            peer_id: String,
            media_id: String,
            pad_index: u8,
            state: GamepadWireState,
        },
        DisconnectPad {
            peer_id: String,
            media_id: String,
            pad_index: u8,
        },
        DisconnectController {
            controller_id: String,
        },
        DisconnectPeer {
            peer_id: String,
        },
        DisconnectAll,
        Reorder {
            ordered_ids: Vec<String>,
        },
        ProbeDriver {
            reply: Sender<VirtualGamepadsStatePayload>,
        },
        GetState {
            reply: Sender<VirtualGamepadsStatePayload>,
        },
        Shutdown {
            reply: Sender<()>,
        },
    }

    struct ActiveVirtualSlot {
        id: String,
        controller_id: String,
        peer_id: String,
        media_id: String,
        pad_index: u8,
        connected_at_ms: u64,
        last_state: GamepadWireState,
        xinput_slot: Option<u32>,
        target: Xbox360Wired<Arc<Client>>,
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn wire_to_xgamepad(state: GamepadWireState) -> XGamepad {
        XGamepad {
            buttons: XButtons(state.buttons),
            left_trigger: state.left_trigger,
            right_trigger: state.right_trigger,
            thumb_lx: state.thumb_lx,
            thumb_ly: state.thumb_ly,
            thumb_rx: state.thumb_rx,
            thumb_ry: state.thumb_ry,
        }
    }

    struct WorkerState {
        client: Option<Arc<Client>>,
        driver_available: bool,
        slots: Vec<ActiveVirtualSlot>,
        last_driver_probe_ms: u64,
        last_missing_driver_notify_ms: u64,
    }

    impl WorkerState {
        fn new() -> Self {
            let client = Client::connect().ok().map(Arc::new);
            let driver_available = client.is_some();
            Self {
                client,
                driver_available,
                slots: Vec::new(),
                last_driver_probe_ms: now_ms(),
                last_missing_driver_notify_ms: 0,
            }
        }

        fn ensure_client(&mut self, force_probe: bool) -> Option<Arc<Client>> {
            if let Some(client) = &self.client {
                self.driver_available = true;
                self.last_missing_driver_notify_ms = 0;
                return Some(Arc::clone(client));
            }
            let now = now_ms();
            if !force_probe && now.saturating_sub(self.last_driver_probe_ms) < 2500 {
                return None;
            }
            self.last_driver_probe_ms = now;
            match Client::connect() {
                Ok(client) => {
                    let arc = Arc::new(client);
                    self.client = Some(Arc::clone(&arc));
                    self.driver_available = true;
                    self.last_missing_driver_notify_ms = 0;
                    crate::logger::log_msg(
                        "INFO",
                        "gamepad",
                        "ViGEmBus virtual gamepad driver connected",
                    );
                    Some(arc)
                }
                Err(_) => {
                    self.driver_available = false;
                    None
                }
            }
        }

        fn snapshot(&mut self) -> VirtualGamepadsStatePayload {
            for slot in &mut self.slots {
                if slot.xinput_slot.is_none() {
                    slot.xinput_slot = slot.target.get_user_index().ok();
                }
            }
            VirtualGamepadsStatePayload {
                driver_available: self.driver_available,
                gamepads: self
                    .slots
                    .iter()
                    .enumerate()
                    .map(|(order, slot)| VirtualGamepadSlotSnapshot {
                        id: slot.id.clone(),
                        controller_id: slot.controller_id.clone(),
                        peer_id: slot.peer_id.clone(),
                        media_id: slot.media_id.clone(),
                        pad_index: slot.pad_index,
                        order,
                        xinput_slot: slot.xinput_slot,
                        connected_at_ms: slot.connected_at_ms,
                    })
                    .collect(),
            }
        }

        fn handle_update(
            &mut self,
            peer_id: String,
            media_id: String,
            pad_index: u8,
            wire_state: GamepadWireState,
        ) {
            let id = make_slot_id(&peer_id, &media_id, pad_index);
            if let Some(idx) = self.slots.iter().position(|s| s.id == id) {
                let slot = &mut self.slots[idx];
                slot.last_state = wire_state;
                let report = wire_to_xgamepad(wire_state);
                if slot.target.update(&report).is_err() {
                    crate::logger::log_msg(
                        "WARN",
                        "gamepad",
                        &format!("Failed to update virtual gamepad {}; dropping client", id),
                    );
                    self.slots.remove(idx);
                    self.client = None;
                    self.driver_available = Client::connect().is_ok();
                    emit_snapshot(None, self.snapshot());
                }
                return;
            }

            if self.slots.len() >= MAX_VIRTUAL_GAMEPADS {
                return;
            }
            let Some(client) = self.ensure_client(false) else {
                emit_snapshot(None, self.snapshot());
                let now = now_ms();
                if now.saturating_sub(self.last_missing_driver_notify_ms)
                    >= MISSING_DRIVER_NOTIFY_INTERVAL_MS
                {
                    self.last_missing_driver_notify_ms = now;
                    emit_missing_driver_needed();
                }
                return;
            };

            let mut target = Xbox360Wired::new(client, TargetId::XBOX360_WIRED);
            if let Err(err) = target.plugin() {
                crate::logger::log_msg(
                    "WARN",
                    "gamepad",
                    &format!("ViGEmBus plugin failed for {}: {:?}", id, err),
                );
                self.client = None;
                self.driver_available = false;
                emit_snapshot(None, self.snapshot());
                return;
            }
            if let Err(err) = target.wait_ready() {
                crate::logger::log_msg(
                    "WARN",
                    "gamepad",
                    &format!("ViGEmBus wait_ready failed for {}: {:?}", id, err),
                );
                let _ = target.unplug();
                return;
            }
            let report = wire_to_xgamepad(wire_state);
            let _ = target.update(&report);
            let xinput_slot = target.get_user_index().ok();
            let controller_id = format!("{peer_id}:{media_id}");
            crate::logger::log_msg(
                "INFO",
                "gamepad",
                &format!(
                    "Plugged virtual Xbox360 gamepad id={} order={} xinput={:?}",
                    id,
                    self.slots.len(),
                    xinput_slot
                ),
            );
            self.slots.push(ActiveVirtualSlot {
                id,
                controller_id,
                peer_id,
                media_id,
                pad_index,
                connected_at_ms: now_ms(),
                last_state: wire_state,
                xinput_slot,
                target,
            });
            emit_snapshot(None, self.snapshot());
        }

        fn remove_matching<F: Fn(&ActiveVirtualSlot) -> bool>(&mut self, predicate: F) {
            let before = self.slots.len();
            let mut remaining = Vec::with_capacity(self.slots.len());
            for mut slot in self.slots.drain(..) {
                if predicate(&slot) {
                    let _ = slot.target.update(&XGamepad::default());
                    let _ = slot.target.unplug();
                    crate::logger::log_msg(
                        "INFO",
                        "gamepad",
                        &format!("Unplugged virtual gamepad {}", slot.id),
                    );
                } else {
                    remaining.push(slot);
                }
            }
            self.slots = remaining;
            if self.slots.len() != before {
                emit_snapshot(None, self.snapshot());
            }
        }

        /// Reassigns virtual controller ownership across the already-plugged ViGEm targets so
        /// Windows XInput player indices swap immediately without USB disconnect chimes.
        fn reorder(&mut self, ordered_ids: Vec<String>) {
            if self.slots.len() <= 1 {
                return;
            }
            let current_ids: Vec<String> = self.slots.iter().map(|s| s.id.clone()).collect();
            let perm = compute_reordered_positions(&current_ids, &ordered_ids);
            let unchanged = perm.iter().enumerate().all(|(i, &src)| i == src);
            if unchanged {
                return;
            }

            // Separate plugged devices from logical player identities.
            let mut old_slots = Vec::new();
            std::mem::swap(&mut self.slots, &mut old_slots);

            let mut device_pool: Vec<(Option<u32>, Xbox360Wired<Arc<Client>>)> = Vec::new();
            let mut identities = Vec::new();
            for mut slot in old_slots {
                if slot.xinput_slot.is_none() {
                    slot.xinput_slot = slot.target.get_user_index().ok();
                }
                device_pool.push((slot.xinput_slot, slot.target));
                identities.push((
                    slot.id,
                    slot.controller_id,
                    slot.peer_id,
                    slot.media_id,
                    slot.pad_index,
                    slot.connected_at_ms,
                    slot.last_state,
                ));
            }
            // Keep lower XInput indices at the front so slot 0 drives Player 1 first, etc.
            device_pool.sort_by_key(|(xslot, _)| xslot.unwrap_or(u32::MAX));

            let mut identity_map: HashMap<usize, _> = identities.into_iter().enumerate().collect();
            for (new_order, &old_idx) in perm.iter().enumerate() {
                if let Some((id, controller_id, peer_id, media_id, pad_index, connected_at_ms, last_state)) =
                    identity_map.remove(&old_idx)
                {
                    let (xinput_slot, mut target) = device_pool.remove(0);
                    let _ = target.update(&wire_to_xgamepad(last_state));
                    crate::logger::log_msg(
                        "INFO",
                        "gamepad",
                        &format!(
                            "Reassigned virtual gamepad id={} -> order={} xinput={:?}",
                            id, new_order, xinput_slot
                        ),
                    );
                    self.slots.push(ActiveVirtualSlot {
                        id,
                        controller_id,
                        peer_id,
                        media_id,
                        pad_index,
                        connected_at_ms,
                        last_state,
                        xinput_slot,
                        target,
                    });
                }
            }
            emit_snapshot(None, self.snapshot());
        }
    }

    static WORKER_TX: LazyLock<Sender<WorkerCmd>> = LazyLock::new(|| {
        let (tx, rx): (Sender<WorkerCmd>, Receiver<WorkerCmd>) = mpsc::channel();
        std::thread::Builder::new()
            .name("p2sharer-gamepad".to_string())
            .spawn(move || {
                let mut state = WorkerState::new();
                emit_snapshot(None, state.snapshot());
                while let Ok(cmd) = rx.recv() {
                    match cmd {
                        WorkerCmd::Update {
                            peer_id,
                            media_id,
                            pad_index,
                            state: wire_state,
                        } => {
                            state.handle_update(peer_id, media_id, pad_index, wire_state);
                        }
                        WorkerCmd::DisconnectPad {
                            peer_id,
                            media_id,
                            pad_index,
                        } => {
                            let target_id = make_slot_id(&peer_id, &media_id, pad_index);
                            state.remove_matching(|s| s.id == target_id);
                        }
                        WorkerCmd::DisconnectController { controller_id } => {
                            state.remove_matching(|s| s.controller_id == controller_id);
                        }
                        WorkerCmd::DisconnectPeer { peer_id } => {
                            state.remove_matching(|s| s.peer_id == peer_id);
                        }
                        WorkerCmd::DisconnectAll => {
                            state.remove_matching(|_| true);
                        }
                        WorkerCmd::Reorder { ordered_ids } => {
                            state.reorder(ordered_ids);
                        }
                        WorkerCmd::ProbeDriver { reply } => {
                            state.client = None;
                            let _ = state.ensure_client(true);
                            let snap = state.snapshot();
                            emit_snapshot(None, snap.clone());
                            let _ = reply.send(snap);
                        }
                        WorkerCmd::GetState { reply } => {
                            let snap = state.snapshot();
                            let _ = reply.send(snap);
                        }
                        WorkerCmd::Shutdown { reply } => {
                            state.remove_matching(|_| true);
                            let _ = reply.send(());
                            break;
                        }
                    }
                }
            })
            .expect("failed to spawn gamepad worker thread");
        tx
    });

    pub fn apply_gamepad_state(
        app: Option<&AppHandle>,
        peer_id: &str,
        media_id: &str,
        pad_index: u8,
        state: GamepadWireState,
    ) {
        if let Some(a) = app {
            set_app_handle(a);
        }
        let _ = WORKER_TX.send(WorkerCmd::Update {
            peer_id: peer_id.to_string(),
            media_id: media_id.to_string(),
            pad_index,
            state,
        });
    }

    pub fn disconnect_gamepad_pad(
        app: Option<&AppHandle>,
        peer_id: &str,
        media_id: &str,
        pad_index: u8,
    ) {
        if let Some(a) = app {
            set_app_handle(a);
        }
        let _ = WORKER_TX.send(WorkerCmd::DisconnectPad {
            peer_id: peer_id.to_string(),
            media_id: media_id.to_string(),
            pad_index,
        });
    }

    pub fn disconnect_controller_gamepads(app: Option<&AppHandle>, controller_id: &str) {
        if let Some(a) = app {
            set_app_handle(a);
        }
        let _ = WORKER_TX.send(WorkerCmd::DisconnectController {
            controller_id: controller_id.to_string(),
        });
    }

    pub fn disconnect_peer_gamepads(app: Option<&AppHandle>, peer_id: &str) {
        if let Some(a) = app {
            set_app_handle(a);
        }
        let _ = WORKER_TX.send(WorkerCmd::DisconnectPeer {
            peer_id: peer_id.to_string(),
        });
    }

    pub fn disconnect_all_gamepads(app: Option<&AppHandle>) {
        if let Some(a) = app {
            set_app_handle(a);
        }
        let _ = WORKER_TX.send(WorkerCmd::DisconnectAll);
    }

    pub fn reorder_gamepads(ordered_ids: Vec<String>) {
        let _ = WORKER_TX.send(WorkerCmd::Reorder { ordered_ids });
    }

    pub fn get_gamepads_state() -> VirtualGamepadsStatePayload {
        let (tx, rx) = mpsc::channel();
        if WORKER_TX.send(WorkerCmd::GetState { reply: tx }).is_ok() {
            if let Ok(state) = rx.recv_timeout(std::time::Duration::from_millis(600)) {
                return state;
            }
        }
        VirtualGamepadsStatePayload {
            driver_available: false,
            gamepads: Vec::new(),
        }
    }

    pub fn probe_driver() -> VirtualGamepadsStatePayload {
        let (tx, rx) = mpsc::channel();
        if WORKER_TX.send(WorkerCmd::ProbeDriver { reply: tx }).is_ok() {
            if let Ok(state) = rx.recv_timeout(std::time::Duration::from_millis(1200)) {
                return state;
            }
        }
        VirtualGamepadsStatePayload {
            driver_available: false,
            gamepads: Vec::new(),
        }
    }

    pub fn shutdown_gamepads() {
        let (tx, rx) = mpsc::channel();
        if WORKER_TX.send(WorkerCmd::Shutdown { reply: tx }).is_ok() {
            let _ = rx.recv_timeout(std::time::Duration::from_millis(500));
        }
    }
}

#[cfg(not(windows))]
mod win_impl {
    use super::*;

    pub fn apply_gamepad_state(
        _app: Option<&AppHandle>,
        _peer_id: &str,
        _media_id: &str,
        _pad_index: u8,
        _state: GamepadWireState,
    ) {
    }

    pub fn disconnect_gamepad_pad(
        _app: Option<&AppHandle>,
        _peer_id: &str,
        _media_id: &str,
        _pad_index: u8,
    ) {
    }

    pub fn disconnect_controller_gamepads(_app: Option<&AppHandle>, _controller_id: &str) {}

    pub fn disconnect_peer_gamepads(_app: Option<&AppHandle>, _peer_id: &str) {}

    pub fn disconnect_all_gamepads(_app: Option<&AppHandle>) {}

    pub fn reorder_gamepads(_ordered_ids: Vec<String>) {}

    pub fn get_gamepads_state() -> VirtualGamepadsStatePayload {
        VirtualGamepadsStatePayload {
            driver_available: false,
            gamepads: Vec::new(),
        }
    }

    pub fn probe_driver() -> VirtualGamepadsStatePayload {
        get_gamepads_state()
    }

    pub fn shutdown_gamepads() {}
}

pub use win_impl::{
    apply_gamepad_state, disconnect_all_gamepads, disconnect_controller_gamepads,
    disconnect_gamepad_pad, disconnect_peer_gamepads, get_gamepads_state, probe_driver,
    reorder_gamepads, shutdown_gamepads,
};

#[tauri::command]
pub fn get_remote_control_gamepads(app: AppHandle) -> VirtualGamepadsStatePayload {
    set_app_handle(&app);
    get_gamepads_state()
}

#[tauri::command]
pub fn recheck_remote_control_gamepad_driver(app: AppHandle) -> VirtualGamepadsStatePayload {
    set_app_handle(&app);
    probe_driver()
}

#[tauri::command]
pub fn reorder_remote_control_gamepads(
    app: AppHandle,
    window: tauri::WebviewWindow,
    ordered_ids: Vec<String>,
) -> Result<VirtualGamepadsStatePayload, String> {
    if window.label() != "main" {
        return Err("Only the main window can reorder virtual gamepads".into());
    }
    set_app_handle(&app);
    reorder_gamepads(ordered_ids);
    Ok(get_gamepads_state())
}

#[cfg(windows)]
fn run_elevated_vigem_installer(installer_path: &std::path::Path) -> Result<InstallerExitOutcome, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::{w, HRESULT, PCWSTR},
        Win32::{
            Foundation::{CloseHandle, ERROR_CANCELLED, WAIT_OBJECT_0},
            System::{
                Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
                Threading::{GetExitCodeProcess, WaitForSingleObject},
            },
            UI::{
                Shell::{
                    ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
                    SHELLEXECUTEINFOW,
                },
                WindowsAndMessaging::SW_HIDE,
            },
        },
    };

    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let _com = ComGuard(hr.is_ok());

    let file_wide: Vec<u16> = installer_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let params_wide: Vec<u16> = "/exenoui /qn /norestart"
        .encode_utf16()
        .chain(Some(0))
        .collect();

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(file_wide.as_ptr()),
        lpParameters: PCWSTR(params_wide.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };

    if let Err(err) = unsafe { ShellExecuteExW(&mut info) } {
        if err.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
            return Ok(InstallerExitOutcome::Cancelled);
        }
        return Err(format!("Failed to launch ViGEmBus installer: {err}"));
    }

    if info.hProcess.is_invalid() {
        return Err("Windows did not return a process handle for ViGEmBus installer".into());
    }

    struct ProcessHandleGuard(windows::Win32::Foundation::HANDLE);
    impl Drop for ProcessHandleGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
    let handle = ProcessHandleGuard(info.hProcess);

    let wait_res = unsafe { WaitForSingleObject(handle.0, 180_000) };
    if wait_res != WAIT_OBJECT_0 {
        return Err("Timed out waiting for the ViGEmBus installer to finish".into());
    }

    let mut exit_code: u32 = 0;
    unsafe { GetExitCodeProcess(handle.0, &mut exit_code) }
        .map_err(|e| format!("Failed to read ViGEmBus installer exit status: {e}"))?;

    classify_installer_exit_code(exit_code)
}

#[tauri::command]
pub async fn install_remote_control_gamepad_driver(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<GamepadDriverInstallResult, String> {
    if window.label() != "main" {
        return Err("Only the main window can install the ViGEmBus driver".into());
    }
    set_app_handle(&app);

    #[cfg(not(windows))]
    {
        return Err("ViGEmBus is only supported on Windows".into());
    }

    #[cfg(windows)]
    {
        if DRIVER_INSTALL_ACTIVE.swap(true, Ordering::SeqCst) {
            return Err("ViGEmBus installation is already in progress".into());
        }

        struct InstallActiveGuard<'a>(&'a AppHandle);
        impl Drop for InstallActiveGuard<'_> {
            fn drop(&mut self) {
                DRIVER_INSTALL_ACTIVE.store(false, Ordering::SeqCst);
                emit_driver_install_stage(self.0, "idle");
            }
        }
        let _active_guard = InstallActiveGuard(&app);

        let initial = probe_driver();
        if initial.driver_available {
            return Ok(GamepadDriverInstallResult {
                status: "already_installed".into(),
                driver_available: true,
            });
        }

        emit_driver_install_stage(&app, "downloading");
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(90))
            .user_agent("P2Sharer")
            .build()
            .map_err(|e| format!("Failed to initialize HTTPS client: {e}"))?;

        let response = client
            .get(VIGEMBUS_INSTALLER_URL)
            .send()
            .await
            .map_err(|e| format!("Failed to download ViGEmBus installer: {e}"))?;

        if !response.status().is_success() {
            return Err(format!(
                "ViGEmBus download failed with HTTP status {}",
                response.status()
            ));
        }

        if let Some(len) = response.content_length() {
            if len as usize > VIGEMBUS_MAX_DOWNLOAD_BYTES {
                return Err("ViGEmBus installer payload exceeded size limit".into());
            }
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("Failed to read ViGEmBus installer download: {e}"))?;

        if bytes.len() > VIGEMBUS_MAX_DOWNLOAD_BYTES || !bytes.starts_with(b"MZ") {
            return Err("Downloaded ViGEmBus file is invalid".into());
        }

        emit_driver_install_stage(&app, "verifying");
        verify_sha256_hex(&bytes, VIGEMBUS_INSTALLER_SHA256)?;

        let mut token_bytes = [0u8; 8];
        getrandom::getrandom(&mut token_bytes).map_err(|e| e.to_string())?;
        let token: String = token_bytes.iter().map(|b| format!("{b:02x}")).collect();
        let stage_dir = std::env::temp_dir().join(format!("p2sharer-vigem-{token}"));
        std::fs::create_dir_all(&stage_dir)
            .map_err(|e| format!("Failed to prepare ViGEmBus temp folder: {e}"))?;

        struct StageDirGuard(std::path::PathBuf);
        impl Drop for StageDirGuard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _stage_guard = StageDirGuard(stage_dir.clone());

        let installer_path = stage_dir.join(VIGEMBUS_INSTALLER_FILENAME);
        {
            use std::io::Write;
            let mut file = std::fs::File::create(&installer_path)
                .map_err(|e| format!("Failed to write ViGEmBus installer: {e}"))?;
            file.write_all(&bytes)
                .map_err(|e| format!("Failed to write ViGEmBus installer bytes: {e}"))?;
            file.sync_all()
                .map_err(|e| format!("Failed to flush ViGEmBus installer file: {e}"))?;
        }

        emit_driver_install_stage(&app, "installing");
        let exec_path = installer_path.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || run_elevated_vigem_installer(&exec_path))
            .await
            .map_err(|e| format!("Installer task panicked: {e}"))??;

        if outcome == InstallerExitOutcome::Cancelled {
            return Ok(GamepadDriverInstallResult {
                status: "cancelled".into(),
                driver_available: false,
            });
        }

        let mut probed = probe_driver();
        if !probed.driver_available && outcome == InstallerExitOutcome::Success {
            tokio::time::sleep(std::time::Duration::from_millis(450)).await;
            probed = probe_driver();
        }

        if probed.driver_available {
            return Ok(GamepadDriverInstallResult {
                status: "installed".into(),
                driver_available: true,
            });
        }

        Ok(GamepadDriverInstallResult {
            status: "reboot_required".into(),
            driver_available: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_id_and_reordered_positions_preserve_unlisted_and_ignore_unknown() {
        assert_eq!(make_slot_id("peer-a", "screen-1", 0), "peer-a:screen-1:0");

        let current = vec![
            "peer-a:screen-1:0".to_string(),
            "peer-b:screen-1:0".to_string(),
            "peer-c:screen-1:0".to_string(),
        ];
        let requested = vec![
            "unknown:screen-1:0".to_string(),
            "peer-c:screen-1:0".to_string(),
            "peer-a:screen-1:0".to_string(),
            "peer-c:screen-1:0".to_string(),
        ];
        assert_eq!(compute_reordered_positions(&current, &requested), vec![2, 0, 1]);
    }

    #[test]
    fn sha256_verification_and_installer_exit_codes_behave_safely() {
        let hello_hash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert!(verify_sha256_hex(b"hello", hello_hash).is_ok());
        assert!(verify_sha256_hex(b"hello", &hello_hash.to_uppercase()).is_ok());
        assert!(verify_sha256_hex(b"tampered", hello_hash).is_err());

        assert_eq!(
            classify_installer_exit_code(0).unwrap(),
            InstallerExitOutcome::Success
        );
        assert_eq!(
            classify_installer_exit_code(3010).unwrap(),
            InstallerExitOutcome::RebootRequired
        );
        assert_eq!(
            classify_installer_exit_code(1641).unwrap(),
            InstallerExitOutcome::RebootRequired
        );
        assert_eq!(
            classify_installer_exit_code(1223).unwrap(),
            InstallerExitOutcome::Cancelled
        );
        assert_eq!(
            classify_installer_exit_code(1602).unwrap(),
            InstallerExitOutcome::Cancelled
        );
        assert!(classify_installer_exit_code(1603).is_err());
    }
}
