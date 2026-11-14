use serde::Serialize;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

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
            }
        }

        fn ensure_client(&mut self, force_probe: bool) -> Option<Arc<Client>> {
            if let Some(client) = &self.client {
                self.driver_available = true;
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
}
