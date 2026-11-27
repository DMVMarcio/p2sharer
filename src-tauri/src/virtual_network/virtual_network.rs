//! Main-process admission and bounded IPC to an opt-in elevated adapter helper.
use crate::virtual_network_policy::{virtual_ip, Grant, Policy, Scope, MTU};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    net::Ipv4Addr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpListener,
    sync::{mpsc, oneshot, watch},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub ip: Ipv4Addr,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    ip: Ipv4Addr,
    peers: Vec<Ipv4Addr>,
    own: Vec<Grant>,
    revision: u64,
}
type Frame = (u8, Vec<u8>);
#[derive(Clone)]
struct Connection {
    sender: mpsc::Sender<Frame>,
    cancel: watch::Sender<bool>,
    generation: u64,
}
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counters {
    sent: u64,
    received: u64,
    dropped: u64,
    peers: HashMap<String, crate::traffic_counters::TrafficTotals>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    ip: Ipv4Addr,
    running: bool,
    active: bool,
    counters: HashMap<String, Counters>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PacketEvent {
    scope: String,
    peer: String,
    data: String,
    sequence: u64,
}
#[derive(Default)]
struct Inner {
    leases: HashSet<String>,
    identity: Option<Identity>,
    policy: Policy,
    connection: Option<Connection>,
    revision: u64,
    generation: u64,
    acknowledgements: HashMap<u64, oneshot::Sender<Result<(), String>>>,
    credits: HashMap<u64, (String, String, Instant)>,
    sequence: u64,
    counters: HashMap<String, HashMap<String, Counters>>,
    #[cfg(all(windows, target_arch = "x86_64"))]
    helpers: Vec<Arc<crate::virtual_network_driver::HelperProcess>>,
}
#[derive(Default, Clone)]
pub struct VirtualNetworkState {
    inner: Arc<Mutex<Inner>>,
    operation: Arc<tokio::sync::Mutex<()>>,
}
fn main_only(window: &tauri::Window) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Only the main window can operate the virtual network".into())
    }
}
fn random_ip() -> Result<Ipv4Addr, String> {
    for _ in 0..64 {
        let mut b = [0; 4];
        getrandom::getrandom(&mut b).map_err(|e| e.to_string())?;
        let (a, c) = match b[0] % 3 {
            0 => (10, 160 + b[1] % 32),
            1 => (172, 16 + b[1] % 16),
            _ => (192, 168),
        };
        let ip = Ipv4Addr::new(a, c, b[2], 1 + b[3] % 254);
        #[cfg(all(windows, target_arch = "x86_64"))]
        if crate::virtual_network_driver::address_conflict(&[ip], None)? {
            continue;
        }
        return Ok(ip);
    }
    Err("No non-conflicting virtual IP is available".into())
}
fn identity_file(app: &tauri::AppHandle, refresh: bool) -> Result<Identity, String> {
    #[cfg(windows)]
    use std::os::windows::fs::OpenOptionsExt;
    use std::{
        fs::OpenOptions,
        io::{Read, Seek, SeekFrom, Write},
    };
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("virtual-network.json");
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(windows)]
    options.share_mode(0);
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > 1024 {
        return Err("Invalid virtual network identity".into());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if !bytes.is_empty() && !refresh {
        let identity: Identity =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid saved virtual IP")?;
        if !virtual_ip(identity.ip) {
            return Err("Invalid saved virtual IP".into());
        }
        return Ok(identity);
    }
    let old = serde_json::from_slice::<Identity>(&bytes).ok();
    let mut ip = random_ip()?;
    while old.as_ref().is_some_and(|old| old.ip == ip) {
        ip = random_ip()?;
    }
    let identity = Identity { ip };
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(&identity).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let end = file.stream_position().map_err(|e| e.to_string())?;
    file.set_len(end).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    Ok(identity)
}
async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Frame, String> {
    let n = reader.read_u32().await.map_err(|e| e.to_string())? as usize;
    if n == 0 || n > 65_536 {
        return Err("Invalid virtual helper frame".into());
    }
    let mut bytes = vec![0; n];
    reader
        .read_exact(&mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    let kind = bytes.remove(0);
    Ok((kind, bytes))
}
async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, frame: &Frame) -> Result<(), String> {
    let mut buf = Vec::with_capacity(5 + frame.1.len());
    buf.extend_from_slice(&((frame.1.len() + 1) as u32).to_be_bytes());
    buf.push(frame.0);
    buf.extend_from_slice(&frame.1);
    writer.write_all(&buf).await.map_err(|e| e.to_string())
}
impl VirtualNetworkState {
    fn idle(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.policy.scopes.is_empty() && inner.leases.is_empty()
    }
    fn identity(&self, app: &tauri::AppHandle) -> Result<Identity, String> {
        let mut state = self.inner.lock().unwrap();
        if let Some(identity) = &state.identity {
            return Ok(identity.clone());
        }
        let identity = identity_file(app, false)?;
        state.identity = Some(identity.clone());
        Ok(identity)
    }
    fn settings(&self) -> Result<Settings, String> {
        let mut state = self.inner.lock().unwrap();
        state.revision += 1;
        Ok(Settings {
            ip: state.identity.as_ref().ok_or("Virtual IP unavailable")?.ip,
            peers: state.policy.peers(),
            own: state
                .policy
                .scopes
                .values()
                .flat_map(|s| s.own.clone())
                .collect(),
            revision: state.revision,
        })
    }
    fn failed(&self, app: &tauri::AppHandle, generation: u64, reason: &str) {
        let mut state = self.inner.lock().unwrap();
        if state
            .connection
            .as_ref()
            .is_none_or(|c| c.generation != generation)
        {
            return;
        }
        if let Some(connection) = state.connection.take() {
            let _ = connection.cancel.send(true);
        }
        state.policy.clear();
        state.credits.clear();
        for (_, ack) in state.acknowledgements.drain() {
            let _ = ack.send(Err(reason.into()));
        }
        let _ = app.emit_to(
            "main",
            "virtual-network-event",
            serde_json::json!({ "error": reason }),
        );
    }
    async fn start(&self, app: tauri::AppHandle, settings: &Settings) -> Result<(), String> {
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            let _ = (app, settings);
            return Err("Virtual networking requires Windows x64".into());
        }
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            let helpers = self.inner.lock().unwrap().helpers.clone();
            tokio::task::spawn_blocking(move || {
                for helper in helpers {
                    helper.wait()?;
                }
                Ok::<_, String>(())
            })
            .await
            .map_err(|e| e.to_string())??;
            self.inner.lock().unwrap().helpers.retain(|p| !p.exited());
            let listener = TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|e| e.to_string())?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let mut entropy = [0; 32];
            getrandom::getrandom(&mut entropy).map_err(|e| e.to_string())?;
            let token: String = entropy.iter().map(|b| format!("{b:02x}")).collect();
            let launch_token = token.clone();
            crate::logger::log_msg("INFO", "virtual_network", "Requesting Windows consent for the virtual adapter helper");
            let process = tokio::task::spawn_blocking(move || {
                crate::virtual_network_driver::elevate(port, &launch_token)
            })
            .await
            .map_err(|e| e.to_string())??;
            crate::logger::log_msg("INFO", "virtual_network", "Virtual adapter helper process launched; awaiting authenticated connection");
            {
                let mut state = self.inner.lock().unwrap();
                state.helpers.retain(|p| !p.exited());
                state.helpers.push(Arc::new(process));
            }
            let mut stream = tokio::time::timeout(Duration::from_secs(45), async {
                loop {
                    let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
                    let _ = stream.set_nodelay(true);
                    if let Ok(Ok((0, authentication))) =
                        tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream)).await
                    {
                        if authentication == token.as_bytes() {
                            return Ok::<_, String>(stream);
                        }
                    }
                }
            })
            .await
            .map_err(|_| "Virtual network helper did not connect")??;
            let initial = serde_json::to_vec(settings).map_err(|e| e.to_string())?;
            write_frame(&mut stream, &(1, initial)).await?;
            let ready = tokio::time::timeout(Duration::from_secs(30), read_frame(&mut stream))
                .await
                .map_err(|_| "Virtual adapter startup timed out")?
                .map_err(|error| format!("Virtual adapter helper disconnected during startup: {error}. Check the native helper log for the failed setup stage."))?;
            if ready.0 == 4 {
                return Err(String::from_utf8_lossy(&ready.1).into_owned());
            }
            if ready.0 != 3 || ready.1 != settings.revision.to_be_bytes() {
                return Err("Invalid virtual adapter startup response".into());
            }
            if self.idle() {
                return Err("Virtual network activation was cancelled".into());
            }
            let (sender, mut frames) = mpsc::channel::<Frame>(4096);
            let (cancel, mut stop_write) = watch::channel(false);
            let mut stop_read = stop_write.clone();
            let generation = {
                let mut state = self.inner.lock().unwrap();
                state.generation += 1;
                let generation = state.generation;
                state.connection = Some(Connection {
                    sender,
                    cancel,
                    generation,
                });
                generation
            };
            let (mut reader, mut writer) = stream.into_split();
            let state = self.clone();
            let handle = app.clone();
            tokio::spawn(async move {
                let mut keepalive = tokio::time::interval(Duration::from_secs(2));
                let mut batch = Vec::with_capacity(65_536);
                loop {
                    let frame = tokio::select! {
                        _ = stop_write.changed() => break,
                        _ = keepalive.tick() => (6, Vec::new()),
                        frame = frames.recv() => match frame { Some(f) => f, None => break },
                    };
                    batch.clear();
                    batch.extend_from_slice(&((frame.1.len() + 1) as u32).to_be_bytes());
                    batch.push(frame.0);
                    batch.extend_from_slice(&frame.1);
                    while batch.len() < 60_000 {
                        let Ok(next) = frames.try_recv() else { break };
                        batch.extend_from_slice(&((next.1.len() + 1) as u32).to_be_bytes());
                        batch.push(next.0);
                        batch.extend_from_slice(&next.1);
                    }
                    if !matches!(
                        tokio::time::timeout(
                            Duration::from_secs(5),
                            writer.write_all(&batch)
                        )
                        .await,
                        Ok(Ok(()))
                    ) {
                        state.failed(
                            &handle,
                            generation,
                            "Virtual network helper stopped responding",
                        );
                        break;
                    }
                }
                let _ = tokio::time::timeout(
                    Duration::from_secs(2),
                    write_frame(&mut writer, &(5, Vec::new())),
                )
                .await;
                let _ = writer.shutdown().await;
            });
            let state = self.clone();
            tokio::spawn(async move {
                loop {
                    let frame = tokio::select! { _ = stop_read.changed() => break,
                    frame = tokio::time::timeout(Duration::from_secs(15), read_frame(&mut reader)) => frame };
                    let Ok(Ok((kind, bytes))) = frame else {
                        state.failed(&app, generation, "Virtual network connection was lost");
                        break;
                    };
                    match kind {
                        2 => state.outgoing(&app, &bytes),
                        3 if bytes.len() == 8 => {
                            let revision = u64::from_be_bytes(bytes.try_into().unwrap());
                            if let Some(ack) = state
                                .inner
                                .lock()
                                .unwrap()
                                .acknowledgements
                                .remove(&revision)
                            {
                                let _ = ack.send(Ok(()));
                            }
                        }
                        7 => {}
                        4 => {
                            state.failed(&app, generation, &String::from_utf8_lossy(&bytes));
                            break;
                        }
                        _ => {
                            state.failed(&app, generation, "Invalid virtual helper response");
                            break;
                        }
                    }
                }
            });
            Ok(())
        }
    }
    fn outgoing(&self, app: &tauri::AppHandle, bytes: &[u8]) {
        let mut state = self.inner.lock().unwrap();
        let Some(identity) = state.identity.clone() else {
            return;
        };
        let Some(route) = state.policy.packet(bytes, identity.ip, None) else {
            return;
        };
        if crate::native_tunnel::try_send_virtual(&route.scope, &route.peer, bytes) {
            let c = state
                .counters
                .entry(route.scope)
                .or_default()
                .entry(route.rule)
                .or_default();
            c.sent += bytes.len() as u64;
            crate::traffic_counters::record_peer_traffic(&mut c.peers, &route.peer, bytes.len(), 0);
            return;
        }
        state
            .credits
            .retain(|_, (_, _, time)| time.elapsed() < Duration::from_secs(5));
        if state.credits.len() >= 2048 {
            state
                .counters
                .entry(route.scope)
                .or_default()
                .entry(route.rule)
                .or_default()
                .dropped += 1;
            return;
        }
        state.sequence = state.sequence.wrapping_add(1);
        let sequence = state.sequence;
        state.credits.insert(
            sequence,
            (route.scope.clone(), route.rule.clone(), Instant::now()),
        );
        let c = state
            .counters
            .entry(route.scope.clone())
            .or_default()
            .entry(route.rule)
            .or_default();
        c.sent += bytes.len() as u64;
        crate::traffic_counters::record_peer_traffic(&mut c.peers, &route.peer, bytes.len(), 0);
        if let Some(result) = crate::peer_payload::emit(app, &route.scope,
            crate::peer_payload::virtual_header(&route.scope, &route.peer, sequence), bytes) {
            if result.is_err() { state.credits.remove(&sequence); }
            return;
        }
        let event = PacketEvent {
            scope: route.scope,
            peer: route.peer,
            data: STANDARD.encode(bytes),
            sequence,
        };
        if app.emit_to("main", "virtual-network-event", event).is_err() {
            state.credits.remove(&sequence);
        }
    }
    async fn configure(
        &self,
        app: tauri::AppHandle,
        scope_id: String,
        scope: Scope,
    ) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        let identity = self.identity(&app)?;
        {
            let state = self.inner.lock().unwrap();
            if state.connection.is_some() && state.policy.scopes.get(&scope_id) == Some(&scope) {
                return Ok(());
            }
        }
        {
            self.inner
                .lock()
                .unwrap()
                .policy
                .configure(&scope_id, scope, identity.ip)?;
        }
        if self.idle() {
            if let Some(connection) = self.inner.lock().unwrap().connection.take() {
                let _ = connection.cancel.send(true);
            }
            return Ok(());
        }
        let settings = self.settings()?;
        let connection = self.inner.lock().unwrap().connection.clone();
        let result = if let Some(connection) = connection {
            let (send, receive) = oneshot::channel();
            self.inner
                .lock()
                .unwrap()
                .acknowledgements
                .insert(settings.revision, send);
            let frame = (1, serde_json::to_vec(&settings).map_err(|e| e.to_string())?);
            if connection.sender.try_send(frame).is_err() {
                Err("Virtual network control queue is full".into())
            } else {
                match tokio::time::timeout(Duration::from_secs(10), receive).await {
                    Ok(Ok(result)) => result,
                    Ok(Err(_)) => Err("Virtual network helper disconnected".into()),
                    Err(_) => Err("Virtual route update timed out".into()),
                }
            }
        } else {
            self.start(app.clone(), &settings).await
        };
        if let Err(error) = &result {
            let generation = self
                .inner
                .lock()
                .unwrap()
                .connection
                .as_ref()
                .map(|c| c.generation);
            if let Some(generation) = generation {
                self.failed(&app, generation, error);
            } else {
                self.inner.lock().unwrap().policy.clear();
            }
        }
        result
    }
    pub fn stop(&self, scope: &str) {
        let mut state = self.inner.lock().unwrap();
        state.leases.remove(scope);
        state.policy.remove(scope);
        state.counters.remove(scope);
        state.credits.retain(|_, (id, _, _)| id != scope);
        if state.policy.scopes.is_empty() && state.leases.is_empty() {
            if let Some(connection) = state.connection.take() {
                let _ = connection.cancel.send(true);
            }
        }
        // Remaining scopes keep only their exact routes until the next control reconciliation.
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        {
            let mut state = self.inner.lock().unwrap();
            state.policy.clear();
            state.leases.clear();
            state.credits.clear();
            if let Some(connection) = state.connection.take() {
                let _ = connection.cancel.send(true);
            }
        }
        let _operation = self.operation.lock().await;
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            let helpers = self.inner.lock().unwrap().helpers.clone();
            tokio::task::spawn_blocking(move || {
                for helper in helpers {
                    helper.wait()?;
                }
                Ok::<_, String>(())
            })
            .await
            .map_err(|e| e.to_string())??;
            self.inner.lock().unwrap().helpers.retain(|p| !p.exited());
        }
        Ok(())
    }
}
#[tauri::command]
pub async fn prepare_virtual_network_app(
    window: tauri::Window,
    state: State<'_, VirtualNetworkState>,
    scope: String,
) -> Result<(), String> {
    main_only(&window)?;
    if scope.len() != 36 || !scope.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("Invalid virtual app scope".into());
    }
    {
        let mut inner = state.inner.lock().unwrap();
        if inner.leases.len() >= 24 && !inner.leases.contains(&scope) {
            return Err("Too many virtual apps".into());
        }
        inner.leases.insert(scope.clone());
    }
    let result = state
        .configure(window.app_handle().clone(), scope.clone(), Scope::default())
        .await;
    if result.is_err() {
        state.stop(&scope);
    }
    result
}
#[tauri::command]
pub fn get_virtual_network_identity(
    window: tauri::Window,
    state: State<'_, VirtualNetworkState>,
) -> Result<Identity, String> {
    main_only(&window)?;
    state.identity(window.app_handle())
}
#[tauri::command]
pub async fn regenerate_virtual_network_ip(
    window: tauri::Window,
    state: State<'_, VirtualNetworkState>,
) -> Result<Identity, String> {
    main_only(&window)?;
    let operation = state.operation.lock().await;
    {
        let mut inner = state.inner.lock().unwrap();
        if !inner.policy.scopes.is_empty() {
            return Err("Disable all virtual tunnels before changing the IP".into());
        }
        if let Some(connection) = inner.connection.take() {
            let _ = connection.cancel.send(true);
        }
        inner.credits.clear();
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        let helpers = state.inner.lock().unwrap().helpers.clone();
        tokio::task::spawn_blocking(move || {
            for helper in helpers {
                helper.wait()?;
            }
            Ok::<_, String>(())
        })
        .await
        .map_err(|e| e.to_string())??;
        state.inner.lock().unwrap().helpers.retain(|p| !p.exited());
    }
    let identity = {
        #[cfg(all(windows, target_arch = "x86_64"))]
        let _guard = crate::virtual_network_driver::NetworkLock::acquire()?;
        identity_file(window.app_handle(), true)?
    };
    let lease = {
        let mut inner = state.inner.lock().unwrap();
        inner.identity = Some(identity.clone());
        inner.leases.iter().next().cloned()
    };
    let _ = window.app_handle().emit_to(
        "main",
        "virtual-network-event",
        serde_json::json!({"ip": identity.ip}),
    );
    drop(operation);
    if let Some(scope) = lease {
        state
            .configure(window.app_handle().clone(), scope, Scope::default())
            .await?;
    }
    Ok(identity)
}
#[tauri::command]
pub async fn configure_virtual_network(
    window: tauri::Window,
    state: State<'_, VirtualNetworkState>,
    scope: String,
    permissions: Scope,
) -> Result<(), String> {
    main_only(&window)?;
    state
        .configure(window.app_handle().clone(), scope, permissions)
        .await
}
#[tauri::command]
pub async fn stop_virtual_network_scope(
    window: tauri::Window,
    state: State<'_, VirtualNetworkState>,
    scope: String,
) -> Result<(), String> {
    main_only(&window)?;
    state.stop(&scope);
    state
        .configure(window.app_handle().clone(), scope, Scope::default())
        .await
}
#[tauri::command]
pub fn get_virtual_network_status(
    window: tauri::Window,
    state: State<'_, VirtualNetworkState>,
    scope: String,
) -> Result<Status, String> {
    main_only(&window)?;
    let identity = state.identity(window.app_handle())?;
    let inner = state.inner.lock().unwrap();
    Ok(Status {
        ip: identity.ip,
        running: inner.connection.is_some(),
        active: inner.policy.scopes.contains_key(&scope),
        counters: inner.counters.get(&scope).cloned().unwrap_or_default(),
    })
}
#[tauri::command]
pub fn virtual_network_sent(
    window: tauri::Window,
    state: State<'_, VirtualNetworkState>,
    scope: String,
    sequence: u64,
    failed: bool,
) -> Result<(), String> {
    main_only(&window)?;
    let mut inner = state.inner.lock().unwrap();
    if inner
        .credits
        .get(&sequence)
        .is_some_and(|(id, _, _)| *id == scope)
    {
        if let Some((id, rule, _)) = inner.credits.remove(&sequence) {
            if failed {
                inner
                    .counters
                    .entry(id)
                    .or_default()
                    .entry(rule)
                    .or_default()
                    .dropped += 1;
            }
        }
    }
    Ok(())
}
#[tauri::command]
pub fn receive_virtual_network_packet(
    window: tauri::Window,
    state: State<'_, VirtualNetworkState>,
    scope: String,
    peer: String,
    data: String,
) -> Result<(), String> {
    main_only(&window)?;
    if data.len() > MTU.div_ceil(3) * 4 {
        return Err("Virtual packet is too large".into());
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "Invalid virtual packet")?;
    receive_bytes(&state, scope, peer, bytes)
}
pub(crate) fn receive_bytes(state: &VirtualNetworkState, scope: String, peer: String, bytes: Vec<u8>) -> Result<(), String> {
    if bytes.len() > MTU { return Err("Virtual packet is too large".into()); }
    let mut inner = state.inner.lock().unwrap();
    let identity = inner.identity.clone().ok_or("Virtual IP unavailable")?;
    let route = inner
        .policy
        .packet(&bytes, identity.ip, Some((&scope, &peer)))
        .ok_or("Virtual packet is not authorized")?;
    let connection = inner
        .connection
        .clone()
        .ok_or("Virtual adapter is disabled")?;
    if connection.sender.try_send((2, bytes.clone())).is_err() {
        inner
            .counters
            .entry(scope)
            .or_default()
            .entry(route.rule)
            .or_default()
            .dropped += 1;
        return Ok(());
    }
    let counter = inner
        .counters
        .entry(scope)
        .or_default()
        .entry(route.rule)
        .or_default();
    counter.received += bytes.len() as u64;
    crate::traffic_counters::record_peer_traffic(&mut counter.peers, &peer, 0, bytes.len());
    Ok(())
}

// The helper uses a separate, synchronous runtime and cannot invoke Tauri commands.
pub fn run_helper_if_requested() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_none_or(|s| s != "--p2sharer-vnet-helper") {
        return false;
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    if args.len() == 4 && args[3].len() == 64 && args[3].bytes().all(|b| b.is_ascii_hexdigit()) {
        if let Ok(port) = args[2].parse::<u16>() {
            if port != 0 {
                crate::logger::init_logger();
                if let Err(error) = helper(port, &args[3]) {
                    crate::logger::log_msg("ERROR", "virtual_network_helper", &error);
                }
            }
        }
    }
    true
}
#[cfg(all(windows, target_arch = "x86_64"))]
fn helper(port: u16, token: &str) -> Result<(), String> {
    use crate::virtual_network_driver::{Device, Firewall, NetworkLock};
    use std::{
        io::{Read, Write},
        net::{Shutdown, TcpStream},
        sync::atomic::{AtomicBool, Ordering},
    };
    fn write(stream: &mut TcpStream, frame: &Frame) -> Result<(), String> {
        let mut buf = Vec::with_capacity(5 + frame.1.len());
        buf.extend_from_slice(&((frame.1.len() + 1) as u32).to_be_bytes());
        buf.push(frame.0);
        buf.extend_from_slice(&frame.1);
        stream.write_all(&buf).map_err(|e| e.to_string())
    }
    fn read(stream: &mut TcpStream) -> Result<Frame, String> {
        let mut size = [0; 4];
        stream.read_exact(&mut size).map_err(|e| e.to_string())?;
        let n = u32::from_be_bytes(size) as usize;
        if n == 0 || n > 65_536 {
            return Err("Invalid virtual control frame".into());
        }
        let mut bytes = vec![0; n];
        stream.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        let kind = bytes.remove(0);
        Ok((kind, bytes))
    }
    fn settings(bytes: &[u8]) -> Result<Settings, String> {
        let settings: Settings =
            serde_json::from_slice(bytes).map_err(|_| "Invalid virtual adapter settings")?;
        if !virtual_ip(settings.ip)
            || settings.peers.len() > 128
            || settings.own.len() > 768
            || settings
                .peers
                .iter()
                .any(|p| !virtual_ip(*p) || *p == settings.ip)
            || settings.own.iter().any(|g| !g.valid())
        {
            return Err("Invalid virtual adapter settings".into());
        }
        Ok(settings)
    }
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream.set_nodelay(true).map_err(|e| e.to_string())?;
    write(&mut stream, &(0, token.as_bytes().to_vec()))?;
    let setup = (|| {
        // Consume the complete configuration before any fallible native operation.
        // Closing with unread peer data can reset TCP and hide the setup error.
        let (kind, bytes) = read(&mut stream)?;
        if kind != 1 {
            return Err("Missing virtual adapter settings".into());
        }
        let config = settings(&bytes)?;
        let guard = NetworkLock::acquire().map_err(|e| format!("Virtual network lock: {e}"))?;
        let firewall =
            Firewall::new().map_err(|e| format!("Virtual firewall initialization: {e}"))?;
        let device = Arc::new(
            Device::open(config.ip).map_err(|e| format!("Virtual adapter initialization: {e}"))?,
        );
        device
            .routes(&config.peers)
            .map_err(|e| format!("Virtual peer route configuration: {e}"))?;
        firewall
            .configure(config.ip, &config.peers, &config.own)
            .map_err(|e| format!("Virtual firewall configuration: {e}"))?;
        Ok::<_, String>((guard, firewall, device, config))
    })();
    let (_guard, firewall, device, mut config) = match setup {
        Ok(x) => x,
        Err(error) => {
            let _ = write(&mut stream, &(4, error.as_bytes().to_vec()));
            finish_helper_error(&mut stream);
            return Err(error);
        }
    };
    write(&mut stream, &(3, config.revision.to_be_bytes().to_vec()))?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let (output, frames) = std::sync::mpsc::sync_channel::<Frame>(4096);
    let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
    let stopped = cancelled.clone();
    let writer_thread = std::thread::spawn(move || {
        let mut batch = Vec::with_capacity(65_536);
        while let Ok(frame) = frames.recv() {
            batch.clear();
            batch.extend_from_slice(&((frame.1.len() + 1) as u32).to_be_bytes());
            batch.push(frame.0);
            batch.extend_from_slice(&frame.1);
            while batch.len() < 60_000 {
                let Ok(next) = frames.try_recv() else { break };
                batch.extend_from_slice(&((next.1.len() + 1) as u32).to_be_bytes());
                batch.push(next.0);
                batch.extend_from_slice(&next.1);
            }
            if writer.write_all(&batch).is_err() {
                break;
            }
        }
        stopped.store(true, Ordering::Release);
        let _ = writer.shutdown(Shutdown::Both);
    });
    let read_device = device.clone();
    let stopped = cancelled.clone();
    let packets = output.clone();
    let packet_thread = std::thread::spawn(move || {
        while !stopped.load(Ordering::Acquire) {
            match read_device.receive() {
                Ok(Some(bytes)) => {
                    let _ = packets.try_send((2, bytes));
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = packets.try_send((4, error.into_bytes()));
                    break;
                }
            }
        }
        stopped.store(true, Ordering::Release);
    });
    let result = (|| -> Result<(), String> {
        while !cancelled.load(Ordering::Acquire) {
            let (kind, bytes) = read(&mut stream)?;
            match kind {
                1 => {
                    let next = settings(&bytes)?;
                    if next.ip != config.ip || next.revision <= config.revision {
                        return Err("Obsolete virtual configuration".into());
                    }
                    device.routes(&next.peers)?;
                    firewall.configure(next.ip, &next.peers, &next.own)?;
                    output
                        .send((3, next.revision.to_be_bytes().to_vec()))
                        .map_err(|e| e.to_string())?;
                    config = next;
                }
                2 => {
                    if bytes.len() < 20
                        || bytes.len() > MTU
                        || bytes[0] != 0x45
                        || Ipv4Addr::new(bytes[16], bytes[17], bytes[18], bytes[19]) != config.ip
                        || !config
                            .peers
                            .contains(&Ipv4Addr::new(bytes[12], bytes[13], bytes[14], bytes[15]))
                    {
                        return Err("Invalid injected virtual packet".into());
                    }
                    device.send(&bytes)?;
                }
                5 => break,
                6 => {
                    output.send((7, Vec::new())).map_err(|e| e.to_string())?;
                }
                _ => return Err("Unknown virtual helper command".into()),
            }
        }
        Ok(())
    })();
    if let Err(error) = &result {
        let _ = output.try_send((4, error.as_bytes().to_vec()));
    }
    cancelled.store(true, Ordering::Release);
    let _ = stream.shutdown(Shutdown::Both);
    let _ = packet_thread.join();
    drop(output);
    let _ = writer_thread.join();
    // Device and firewall RAII remove exact routes, address, rules and the created adapter.
    result
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn finish_helper_error(stream: &mut std::net::TcpStream) {
    use std::io::Read;
    // Deliver the error before closing; the parent closes after receiving it.
    // Bound both elapsed time and drained bytes if the parent is unresponsive.
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let _ = std::io::copy(&mut stream.take(65_536), &mut std::io::sink());
}

#[cfg(all(test, windows, target_arch = "x86_64"))]
mod startup_tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn admitted_traffic_is_counted_per_participant_without_counting_rejected_packets() {
        use crate::virtual_network_policy::Peer;
        let state = VirtualNetworkState::default();
        let scope = "11111111-1111-4111-8111-111111111111";
        let rule = "22222222-2222-4222-8222-222222222222";
        let local = Ipv4Addr::new(10, 160, 1, 1);
        let first = Ipv4Addr::new(10, 160, 1, 2);
        let second = Ipv4Addr::new(10, 160, 1, 3);
        let (sender, mut receiver) = mpsc::channel(8);
        let (cancel, _) = watch::channel(false);
        {
            let mut inner = state.inner.lock().unwrap();
            inner.identity = Some(Identity { ip: local });
            inner.connection = Some(Connection { sender, cancel, generation: 1 });
            inner.policy.configure(scope, Scope {
                own: vec![Grant { id: rule.into(), port: 12345, protocol: "udp".into(),
                    generation: "33333333-3333-4333-8333-333333333333".into() }],
                peers: vec![Peer { id: "first".into(), ip: first, grants: vec![] },
                    Peer { id: "second".into(), ip: second, grants: vec![] }],
            }, local).unwrap();
        }
        let packet = |source: Ipv4Addr| {
            let mut bytes = vec![0u8; 28];
            bytes[0] = 0x45; bytes[2..4].copy_from_slice(&28u16.to_be_bytes());
            bytes[8] = 64; bytes[9] = 17;
            bytes[12..16].copy_from_slice(&source.octets());
            bytes[16..20].copy_from_slice(&local.octets());
            bytes[20..22].copy_from_slice(&40000u16.to_be_bytes());
            bytes[22..24].copy_from_slice(&12345u16.to_be_bytes());
            let mut sum: u32 = bytes[..20].chunks_exact(2)
                .map(|pair| u16::from_be_bytes([pair[0], pair[1]]) as u32).sum();
            while sum > 0xffff { sum = (sum & 0xffff) + (sum >> 16); }
            bytes[10..12].copy_from_slice(&(!(sum as u16)).to_be_bytes());
            bytes
        };
        receive_bytes(&state, scope.into(), "first".into(), packet(first)).unwrap();
        receive_bytes(&state, scope.into(), "first".into(), packet(first)).unwrap();
        receive_bytes(&state, scope.into(), "second".into(), packet(second)).unwrap();
        assert!(receive_bytes(&state, scope.into(), "first".into(), packet(second)).is_err());
        assert_eq!(receiver.try_recv().unwrap().1, packet(first));
        let inner = state.inner.lock().unwrap();
        let totals = &inner.counters[scope][rule];
        assert_eq!((totals.sent, totals.received), (0, 84));
        assert_eq!(totals.peers["first"].received, 56);
        assert_eq!(totals.peers["second"].received, 28);
    }

    #[test]
    fn app_leases_keep_an_idle_session_until_the_last_app_leaves() {
        let state = VirtualNetworkState::default();
        assert!(state.idle());
        state
            .inner
            .lock()
            .unwrap()
            .leases
            .extend(["one".into(), "two".into()]);
        // An empty permission policy must not discard app preparation.
        state.inner.lock().unwrap().policy.clear();
        assert!(!state.idle());
        state.stop("one");
        assert!(!state.idle());
        state.stop("two");
        assert!(state.idle());
    }

    #[test]
    fn startup_error_is_delivered_even_with_unread_configuration() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let helper = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let message = b"Virtual adapter initialization: synthetic setup failure";
            stream
                .write_all(&((message.len() + 1) as u32).to_be_bytes())
                .unwrap();
            stream.write_all(&[4]).unwrap();
            stream.write_all(message).unwrap();
            finish_helper_error(&mut stream);
        });
        let mut parent = std::net::TcpStream::connect(address).unwrap();
        parent
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        parent.write_all(&[0; 1024]).unwrap();
        let mut response = [0; 4];
        parent.read_exact(&mut response).unwrap();
        let mut body = vec![0; u32::from_be_bytes(response) as usize];
        parent.read_exact(&mut body).unwrap();
        assert_eq!(body[0], 4);
        assert_eq!(
            &body[1..],
            b"Virtual adapter initialization: synthetic setup failure"
        );
        drop(parent);
        helper.join().unwrap();
    }
}
